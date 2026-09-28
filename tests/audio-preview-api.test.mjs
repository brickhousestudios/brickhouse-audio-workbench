import assert from 'node:assert/strict'
import test from 'node:test'
import { handleAudioApi } from '../lib/audio-api.ts'

const env = {
  BRICKHOUSE_AUDIO_RELAY_URL: 'https://relay.example',
  BRICKHOUSE_AUDIO_CONTROL_TOKEN: 'relay-token',
}

function authedRequest(path, init = {}) {
  const headers = new Headers(init.headers || {})
  headers.set('oai-authenticated-user-id', 'brickhouse-producer')
  headers.set('oai-authenticated-user-email', 'producer@example.test')
  return new Request(`https://workbench.example${path}`, { ...init, headers })
}

test('preview Range request returns bounded same-origin audio bytes without exposing private artifact data', async () => {
  const calls = []
  const response = await handleAudioApi(
    authedRequest('/api/audio/artifacts/hfart_vocals/preview', { headers: { range: 'bytes=3-5' } }),
    env,
    async (request) => {
      calls.push({ url: request.url, body: await request.clone().text() })
      return Response.json({
        artifactId: 'hfart_vocals',
        name: 'vocals.wav',
        mimeType: 'audio/wav',
        offset: 3,
        chunkBytes: 3,
        totalBytes: 8,
        nextOffset: 6,
        eof: false,
        chunkBase64: Buffer.from('ABC').toString('base64'),
      })
    },
  )
  assert.ok(response)
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-type'), 'audio/wav')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(response.headers.get('content-range'), 'bytes 3-5/8')
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'ABC')
  assert.equal(calls.length, 1)
  assert.match(calls[0].body, /\/v1\/audio\/artifacts\/hfart_vocals\/preview\/3\/3/)
  assert.equal(calls[0].body.includes('hf://'), false)
})

async function proxyMutation(path, body, upstreamJson) {
  let relayBody
  const response = await handleAudioApi(
    authedRequest(path, {
      method: 'POST',
      headers: { origin: 'https://workbench.example', 'content-type': 'application/json', 'x-brickhouse-operation-id': 'human-op-1' },
      body: JSON.stringify(body),
    }),
    env,
    async (request) => {
      relayBody = JSON.parse(await request.text())
      return Response.json(upstreamJson)
    },
  )
  return { response, relayBody }
}

test('producer-loop GET proxies the proven A3 projection through the existing relay', async () => {
  let relayBody
  const response = await handleAudioApi(
    authedRequest('/api/audio/producer-loop'),
    env,
    async (request) => {
      relayBody = JSON.parse(await request.text())
      return Response.json({ producerLoop: { userId: 'brickhouse-producer', revision: 3, nodes: { source: 'VERIFIED' } } })
    },
  )
  assert.ok(response)
  assert.equal(response.status, 200)
  assert.equal(relayBody.path, '/v1/audio/producer-loop')
  assert.equal(relayBody.method, 'GET')
})

test('destination verify/clear and review proxy exact upstream paths and bodies', async () => {
  const verify = await proxyMutation(
    '/api/audio/audiotool/destination/verify',
    { expectedRevision: 4, projectUuid: '11111111-1111-4111-8111-111111111111' },
    { session: { revision: 5 }, verification: { projectUuid: '11111111-1111-4111-8111-111111111111', displayName: 'Studio Project' } },
  )
  assert.equal(verify.response.status, 200)
  assert.equal(verify.relayBody.path, '/v1/audio/audiotool/destination/verify')
  assert.deepEqual(JSON.parse(verify.relayBody.bodyText), { expectedRevision: 4, projectUuid: '11111111-1111-4111-8111-111111111111' })

  const cleared = await proxyMutation(
    '/api/audio/audiotool/destination/clear',
    { expectedRevision: 5 },
    { session: { revision: 6, audiotoolDestination: null } },
  )
  assert.equal(cleared.response.status, 200)
  assert.equal(cleared.relayBody.path, '/v1/audio/audiotool/destination/clear')
  assert.deepEqual(JSON.parse(cleared.relayBody.bodyText), { expectedRevision: 5 })

  const review = await proxyMutation(
    '/api/audio/audiotool/review',
    { expectedRevision: 6, operationId: 'review-op-1' },
    { session: { revision: 7, pendingDeliveryReview: { status: 'NEEDS_USER', operationId: 'review-op-1' } } },
  )
  assert.equal(review.response.status, 200)
  assert.equal(review.relayBody.path, '/v1/audio/audiotool/review')
  assert.deepEqual(JSON.parse(review.relayBody.bodyText), { expectedRevision: 6, operationId: 'review-op-1' })

  const bundleReview = await proxyMutation(
    '/api/audio/audiotool/bundle/review',
    { expectedRevision: 7, operationId: 'bundle-review-op-1' },
    { session: { revision: 8, pendingBundleDeliveryReview: { status: 'NEEDS_USER', operationId: 'bundle-review-op-1' } } },
  )
  assert.equal(bundleReview.response.status, 200)
  assert.equal(bundleReview.relayBody.path, '/v1/audio/audiotool/bundle/review')
  assert.deepEqual(JSON.parse(bundleReview.relayBody.bodyText), { expectedRevision: 7, operationId: 'bundle-review-op-1' })
})

test('human confirm and undo proxy only the approved bodies onto proven A3 routes', async () => {
  const confirm = await proxyMutation(
    '/api/audio/audiotool/delivery/confirm',
    { expectedRevision: 9, operationId: 'review-op-1', confirm: true },
    { session: { revision: 10, deliveryLifecycle: { status: 'VERIFIED' } }, receipt: { receiptId: 'rcpt-1', status: 'sent' } },
  )
  assert.equal(confirm.response.status, 200)
  assert.equal(confirm.relayBody.path, '/v1/audio/audiotool/delivery/confirm')
  assert.deepEqual(JSON.parse(confirm.relayBody.bodyText), { expectedRevision: 9, operationId: 'review-op-1', confirm: true })

  const bundleConfirm = await proxyMutation(
    '/api/audio/audiotool/bundle/delivery/confirm',
    { expectedRevision: 10, operationId: 'bundle-review-op-1', confirm: true },
    { session: { revision: 11, bundleDeliveryLifecycle: { status: 'VERIFIED' } }, bundleDelivery: { status: 'VERIFIED' } },
  )
  assert.equal(bundleConfirm.response.status, 200)
  assert.equal(bundleConfirm.relayBody.path, '/v1/audio/audiotool/bundle/delivery/confirm')
  assert.deepEqual(JSON.parse(bundleConfirm.relayBody.bodyText), { expectedRevision: 10, operationId: 'bundle-review-op-1', confirm: true })

  const bundleMove = await proxyMutation(
    '/api/audio/audiotool/bundle/member/move',
    {
      expectedRevision: 11,
      lifecycleOperationId: 'bundle-review-op-1',
      memberOperationId: 'bundle-review-op-1.member.1',
      operationId: 'bundle-move-op-1',
      bars: 1,
    },
    { session: { revision: 12 }, receipt: { status: 'REGION_MOVE_REMOTE_VERIFIED', operationId: 'bundle-move-op-1', bars: 1 } },
  )
  assert.equal(bundleMove.response.status, 200)
  assert.equal(bundleMove.relayBody.path, '/v1/audio/audiotool/bundle/member/move')
  assert.deepEqual(JSON.parse(bundleMove.relayBody.bodyText), {
    expectedRevision: 11,
    lifecycleOperationId: 'bundle-review-op-1',
    memberOperationId: 'bundle-review-op-1.member.1',
    operationId: 'bundle-move-op-1',
    bars: 1,
  })

  const undo = await proxyMutation(
    '/api/audio/audiotool/delivery/undo',
    { expectedRevision: 10, receiptId: 'rcpt-1', confirm: true },
    { session: { revision: 11, deliveryLifecycle: { status: 'ROLLED_BACK' } }, receipt: { receiptId: 'rcpt-1', status: 'undone' } },
  )
  assert.equal(undo.response.status, 200)
  assert.equal(undo.relayBody.path, '/v1/audio/audiotool/delivery/undo')
  assert.deepEqual(JSON.parse(undo.relayBody.bodyText), { expectedRevision: 10, receiptId: 'rcpt-1', confirm: true })
})

test('legacy /api/audio/deliver/audiotool routes no longer resolve', async () => {
  const send = await handleAudioApi(
    authedRequest('/api/audio/deliver/audiotool', {
      method: 'POST',
      headers: { origin: 'https://workbench.example', 'content-type': 'application/json', 'x-brickhouse-operation-id': 'legacy-send' },
      body: JSON.stringify({ expectedRevision: 9 }),
    }),
    env,
    async () => Response.json({ ok: true }),
  )
  assert.equal(send, null)

  const undo = await handleAudioApi(
    authedRequest('/api/audio/deliver/audiotool/undo', {
      method: 'POST',
      headers: { origin: 'https://workbench.example', 'content-type': 'application/json', 'x-brickhouse-operation-id': 'legacy-undo' },
      body: JSON.stringify({ expectedRevision: 9, receiptId: 'x', confirm: true }),
    }),
    env,
    async () => Response.json({ ok: true }),
  )
  assert.equal(undo, null)
})

test('unsupported secondary audio routes fail closed before relay execution', async () => {
  let calls = 0
  const fetchImpl = async () => { calls += 1; return Response.json({ ok: true }) }
  const cases = [
    authedRequest('/api/audio/audiotool/regions?projectUuid=11111111-1111-4111-8111-111111111111'),
    authedRequest('/api/audio/audiotool/analyze', { method: 'POST', headers: { origin: 'https://workbench.example', 'content-type': 'application/json', 'x-brickhouse-operation-id': 'analyze-vocal-1' }, body: JSON.stringify({ projectUuid: '11111111-1111-4111-8111-111111111111', regionId: 'region-1' }) }),
    authedRequest('/api/audio/conversation/ask', { method: 'POST', headers: { origin: 'https://workbench.example', 'content-type': 'application/json', 'x-brickhouse-operation-id': 'ask-audio-1' }, body: JSON.stringify({ expectedRevision: 4, question: 'Why does the hook feel bigger?', researchAudioApproved: true }) }),
  ]
  for (const request of cases) assert.equal(await handleAudioApi(request, env, fetchImpl), null)
  assert.equal(calls, 0)
})

test('Audiotool confirm preserves a sanitized stale-revision conflict from the relay', async () => {
  const response = await handleAudioApi(
    authedRequest('/api/audio/audiotool/delivery/confirm', {
      method: 'POST',
      headers: { origin: 'https://workbench.example', 'content-type': 'application/json', 'x-brickhouse-operation-id': 'human-send-stale' },
      body: JSON.stringify({ expectedRevision: 18, operationId: 'review-op-1', confirm: true }),
    }),
    env,
    async () => Response.json({ error: 'stale audio session revision: expected 18, current 19', path: '/private/hidden' }, { status: 409 }),
  )
  assert.ok(response)
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.deepEqual(body, { error: 'stale audio session revision: expected 18, current 19' })
})

test('producer-context GET proxies exact read-only musical context through the relay', async () => {
  let relayBody
  const response = await handleAudioApi(
    authedRequest('/api/audio/producer-context'),
    env,
    async (request) => {
      relayBody = JSON.parse(await request.text())
      return Response.json({ context: { revision: 55, projectUuid: 'f0903a9a-84ce-4e45-a718-975b8214f621', tempoBpm: 120, tempoEvidence: 'NEXUS_CONFIG_AND_PROJECT_METADATA', timeSignature: { numerator: 4, denominator: 4 }, key: null } })
    },
  )
  assert.ok(response)
  assert.equal(response.status, 200)
  assert.equal(relayBody.path, '/v1/audio/producer-context')
  assert.equal(relayBody.method, 'GET')
})

test('candidate page GET proxies exact bounded read-only page path through the relay', async () => {
  let relayBody
  const response = await handleAudioApi(
    authedRequest('/api/audio/candidates/0'),
    env,
    async (request) => {
      relayBody = JSON.parse(await request.text())
      return Response.json({ page: 0, candidates: [{ candidateId: 'looperman:100001', provider: 'looperman', providerId: '100001', localPath: '/private/looperman/100001.mp3' }] })
    },
  )
  assert.ok(response)
  assert.equal(response.status, 200)
  assert.equal(relayBody.path, '/v1/audio/candidates/0')
  assert.equal(relayBody.method, 'GET')
  const body = await response.json()
  assert.equal(body.candidates[0].provider, 'looperman')
  assert.equal(body.candidates[0].providerId, '100001')
  assert.equal(body.candidates[0].localPath, undefined)
  assert.equal(JSON.stringify(body).includes('/private/looperman'), false)
})


test('Producer Library preview Range request proxies exact bounded candidate bytes with no private path leak', async () => {
  let relayBody
  const response = await handleAudioApi(
    authedRequest('/api/audio/library/candidates/100001/preview', { headers: { range: 'bytes=1-3' } }),
    env,
    async (request) => {
      relayBody = JSON.parse(await request.text())
      return Response.json({
        candidate: { candidateId: 'looperman:100001', title: 'Candidate' },
        mimeType: 'audio/mpeg', offset: 1, chunkBytes: 3, totalBytes: 6,
        chunkBase64: Buffer.from('bcd').toString('base64'),
      })
    },
  )
  assert.ok(response)
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 1-3/6')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'bcd')
  assert.equal(relayBody.path, '/v1/audio/library/candidates/100001/preview/1/3')
  assert.equal(JSON.stringify(relayBody).includes('/private/'), false)
})
test('Producer Library preview defaults and open-ended ranges stay within the 256 KiB authority cap', async () => {
  for (const rangeHeader of [null, 'bytes=0-']) {
    let relayBody;
    const headers = rangeHeader ? { range: rangeHeader } : {};
    const response = await handleAudioApi(
      authedRequest('/api/audio/library/candidates/100001/preview', { headers }),
      env,
      async (request) => {
        relayBody = JSON.parse(await request.text());
        return Response.json({
          candidate: { candidateId: 'looperman:100001', title: 'Candidate' },
          mimeType: 'audio/mpeg', offset: 0, chunkBytes: 3, totalBytes: 300000,
          chunkBase64: Buffer.from('abc').toString('base64'),
        });
      },
    );
    assert.ok(response);
    assert.equal(response.status, 206);
    assert.equal(relayBody.path, '/v1/audio/library/candidates/100001/preview/0/262144');
  }
});

test('Producer Library Play Next More Keep Choose proxy only their shared Workbench mutation paths', async () => {
  for (const [action, body] of [
    ['play', { expectedRevision: 3, candidateId: 'looperman:100001' }],
    ['next', { expectedRevision: 4 }],
    ['more', { expectedRevision: 5 }],
    ['hold', { expectedRevision: 6, candidateId: 'looperman:100002' }],
    ['choose', { expectedRevision: 7, candidateId: 'looperman:100003' }],
  ]) {
    const result = await proxyMutation(`/api/audio/library/${action}`, body, { session: { revision: body.expectedRevision + 1 } })
    assert.equal(result.response.status, 200)
    assert.equal(result.relayBody.path, `/v1/audio/library/${action}`)
    assert.deepEqual(JSON.parse(result.relayBody.bodyText), body)
    assert.equal(result.relayBody.path.includes('/audiotool/delivery/'), false)
  }
})

test('Producer Library Bundle mutations proxy only authoritative Workbench Bundle paths', async () => {
  for (const [action, body] of [
    ['add', { expectedRevision: 8, candidateId: 'looperman:100001' }],
    ['remove', { expectedRevision: 9, candidateId: 'looperman:100001' }],
    ['reorder', { expectedRevision: 10, candidateIds: ['looperman:100002', 'looperman:100001'] }],
    ['clear', { expectedRevision: 11 }],
  ]) {
    const result = await proxyMutation(`/api/audio/library/bundle/${action}`, body, { session: { revision: body.expectedRevision + 1 } })
    assert.equal(result.response.status, 200)
    assert.equal(result.relayBody.path, `/v1/audio/library/bundle/${action}`)
    assert.deepEqual(JSON.parse(result.relayBody.bodyText), body)
    assert.equal(result.relayBody.path.includes('/audiotool/delivery/'), false)
  }
})


test('mutation origin uses the externally validated Host when Next standalone request URL is internal', async () => {
  let relayBody
  const headers = new Headers({
    origin: 'http://127.0.0.1:3041',
    host: '127.0.0.1:3041',
    'content-type': 'application/json',
    'x-brickhouse-operation-id': 'library-local-hold-1',
    'oai-authenticated-user-id': 'brickhouse-producer',
    'oai-authenticated-user-email': 'producer@example.test',
  })
  const response = await handleAudioApi(
    new Request('http://localhost:3041/api/audio/library/hold', {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedRevision: 62, candidateId: 'looperman:117823' }),
    }),
    env,
    async (request) => {
      relayBody = JSON.parse(await request.text())
      return Response.json({ session: { revision: 63 } })
    },
  )
  assert.equal(response.status, 200)
  assert.equal(relayBody.path, '/v1/audio/library/hold')
})

test('mutation origin still rejects conflicting forwarded host evidence', async () => {
  const headers = new Headers({
    origin: 'http://127.0.0.1:3041',
    host: '127.0.0.1:3041',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-proto': 'http',
    'content-type': 'application/json',
    'x-brickhouse-operation-id': 'library-local-hold-2',
    'oai-authenticated-user-id': 'brickhouse-producer',
    'oai-authenticated-user-email': 'producer@example.test',
  })
  const response = await handleAudioApi(
    new Request('http://localhost:3041/api/audio/library/hold', {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedRevision: 62, candidateId: 'looperman:117823' }),
    }),
    env,
    async () => Response.json({ session: { revision: 63 } }),
  )
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'Cross-origin request blocked' })
})

test('Producer Library mutations preserve same-origin and operation-id guards', async () => {
  const missingOperation = await handleAudioApi(
    authedRequest('/api/audio/library/play', { method: 'POST', headers: { origin: 'https://workbench.example', 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, candidateId: 'looperman:100001' }) }),
    env,
    async () => Response.json({ session: { revision: 2 } }),
  )
  assert.equal(missingOperation.status, 400)
  assert.deepEqual(await missingOperation.json(), { error: 'Operation ID required' })
})

test('relay auth token is isolated from the local authority token when both are configured', async () => {
  let seenAuthorization = null
  const response = await handleAudioApi(
    authedRequest('/api/audio/producer-loop'),
    {
      BRICKHOUSE_AUDIO_RELAY_URL: 'https://relay.example',
      BRICKHOUSE_AUDIO_RELAY_TOKEN: 'preview-relay-token',
      BRICKHOUSE_AUDIO_CONTROL_TOKEN: 'local-authority-token',
    },
    async (request) => {
      seenAuthorization = request.headers.get('authorization')
      return Response.json({ producerLoop: { revision: 1 } })
    },
  )
  assert.equal(response.status, 200)
  assert.equal(seenAuthorization, 'Bearer preview-relay-token')
})
