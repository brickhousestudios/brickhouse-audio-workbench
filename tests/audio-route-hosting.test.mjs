import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { handleAudioApi } from '../lib/audio-api.ts'

const routeSource = readFileSync(new URL('../app/api/audio/[...path]/route.ts', import.meta.url), 'utf8')

test('Next audio route exposes both relay and direct BrickHouse control transports', () => {
  assert.match(routeSource, /BRICKHOUSE_AUDIO_RELAY_URL:\s*process\.env\.BRICKHOUSE_AUDIO_RELAY_URL/)
  assert.match(routeSource, /BRICKHOUSE_AUDIO_RELAY_TOKEN:\s*process\.env\.BRICKHOUSE_AUDIO_RELAY_TOKEN/)
  assert.match(routeSource, /BRICKHOUSE_AUDIO_CONTROL_URL:\s*process\.env\.BRICKHOUSE_AUDIO_CONTROL_URL/)
})

test('direct control fallback preserves server-only producer authority when relay is absent', async () => {
  let upstream
  const headers = new Headers({ 'oai-authenticated-user-id': 'producer-id', 'oai-authenticated-user-email': 'producer@example.test' })
  const response = await handleAudioApi(new Request('http://127.0.0.1:3041/api/audio/session', { headers }), {
    BRICKHOUSE_AUDIO_CONTROL_URL: 'http://127.0.0.1:3040',
    BRICKHOUSE_AUDIO_CONTROL_TOKEN: 'control-token',
  }, async (request) => {
    upstream = request
    return Response.json({ session: { revision: 1 } })
  })
  assert.equal(response?.status, 200)
  assert.equal(upstream?.url, 'http://127.0.0.1:3040/v1/audio/session')
  assert.equal(upstream?.headers.get('x-brickhouse-user-id'), 'producer-id')
  assert.equal(upstream?.headers.get('x-brickhouse-control-token'), 'control-token')
})

test('relay transport uses relay-specific auth without reusing the local authority token', async () => {
  let upstream
  const headers = new Headers({ 'oai-authenticated-user-id': 'producer-id', 'oai-authenticated-user-email': 'producer@example.test' })
  const response = await handleAudioApi(new Request('https://workbench.example/api/audio/session', { headers }), {
    BRICKHOUSE_AUDIO_RELAY_URL: 'https://relay.example',
    BRICKHOUSE_AUDIO_RELAY_TOKEN: 'relay-test-token',
    BRICKHOUSE_AUDIO_CONTROL_TOKEN: 'control-test-token',
  }, async (request) => {
    upstream = request
    return Response.json({ session: { revision: 1 } })
  })
  assert.equal(response?.status, 200)
  assert.equal(upstream?.url, 'https://relay.example/api/request')
  assert.equal(upstream?.headers.get('authorization'), 'Bearer relay-test-token')
  assert.notEqual(upstream?.headers.get('authorization'), 'Bearer control-test-token')
})
