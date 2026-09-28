import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizeProducerSession, applyProducerIdentity } from '../lib/producer-auth.ts'

const env = {
  BRICKHOUSE_AUTH_GITHUB_SUB: '123456',
  BRICKHOUSE_PRODUCER_USER_ID: 'producer-authority',
  BRICKHOUSE_PRODUCER_USER_EMAIL: 'producer@example.test',
}

test('producer authorization fails closed for missing or wrong GitHub identity', () => {
  assert.equal(authorizeProducerSession(null, env).status, 401)
  assert.equal(authorizeProducerSession({ user: { githubSub: '999999' } }, env).status, 403)
  assert.equal(authorizeProducerSession({ user: { githubSub: '123456' } }, {}).status, 503)
})

test('exact GitHub subject maps to server-owned BrickHouse producer identity', () => {
  const result = authorizeProducerSession({ user: { githubSub: '123456' } }, env)
  assert.deepEqual(result, { ok: true, userId: 'producer-authority', userEmail: 'producer@example.test' })
})

test('submission judge access is separately gated and maps to a separate BrickHouse identity', () => {
  const submissionEnv = {
    ...env,
    BRICKHOUSE_SUBMISSION_ACCESS_ENABLED: '1',
    BRICKHOUSE_SUBMISSION_ACCESS_CODE: 'judge-code-123',
    BRICKHOUSE_SUBMISSION_USER_ID: 'submission-judge',
    BRICKHOUSE_SUBMISSION_USER_EMAIL: 'judge@example.test',
  }
  assert.deepEqual(
    authorizeProducerSession({ user: { submissionAccess: true } }, submissionEnv),
    { ok: true, userId: 'submission-judge', userEmail: 'judge@example.test' },
  )
  assert.equal(authorizeProducerSession({ user: { submissionAccess: true } }, { ...submissionEnv, BRICKHOUSE_SUBMISSION_ACCESS_ENABLED: '0' }).status, 403)
  assert.equal(authorizeProducerSession({ user: { submissionAccess: true } }, { ...submissionEnv, BRICKHOUSE_SUBMISSION_ACCESS_CODE: '' }).status, 403)
  assert.equal(authorizeProducerSession({ user: { submissionAccess: true } }, { ...submissionEnv, BRICKHOUSE_SUBMISSION_USER_ID: '' }).status, 403)
  assert.equal(authorizeProducerSession({ user: { submissionAccess: true } }, { ...submissionEnv, BRICKHOUSE_SUBMISSION_USER_EMAIL: '' }).status, 403)
})

test('loopback self-host mode uses only the configured server-owned producer identity', () => {
  const selfHost = {
    BRICKHOUSE_PRODUCER_USER_ID: 'producer-authority',
    BRICKHOUSE_PRODUCER_USER_EMAIL: 'producer@example.test',
    BRICKHOUSE_SELF_HOST: '1',
    BRICKHOUSE_AUTH_ALLOWED_HOSTS: '127.0.0.1:3041,localhost:3041',
    BRICKHOUSE_AUTH_EXPECTED_PROTO: 'http',
  }
  assert.deepEqual(authorizeProducerSession(null, selfHost), { ok: true, userId: 'producer-authority', userEmail: 'producer@example.test' })
  assert.deepEqual(authorizeProducerSession(null, { ...selfHost, BRICKHOUSE_AUTH_ALLOWED_HOSTS: '127.0.0.1:3111,localhost:3111' }), { ok: true, userId: 'producer-authority', userEmail: 'producer@example.test' })
  assert.equal(authorizeProducerSession(null, { ...selfHost, BRICKHOUSE_AUTH_ALLOWED_HOSTS: '127.0.0.1:3041,example.com' }).status, 401)
  assert.equal(authorizeProducerSession(null, { ...selfHost, BRICKHOUSE_AUTH_ALLOWED_HOSTS: 'localhost:0' }).status, 401)
  assert.equal(authorizeProducerSession(null, { ...selfHost, BRICKHOUSE_AUTH_ALLOWED_HOSTS: 'localhost:65536' }).status, 401)
  assert.equal(authorizeProducerSession(null, { ...selfHost, BRICKHOUSE_AUTH_EXPECTED_PROTO: 'https' }).status, 401)
  assert.equal(authorizeProducerSession(null, { ...selfHost, BRICKHOUSE_PRODUCER_USER_ID: '' }).status, 503)
})

test('caller identity headers are replaced, never trusted', () => {
  const headers = new Headers({ 'oai-authenticated-user-id': 'spoofed', 'oai-authenticated-user-email': 'spoofed@example.test', range: 'bytes=0-9' })
  const mapped = applyProducerIdentity(headers, { ok: true, userId: 'producer-authority', userEmail: 'producer@example.test' })
  assert.equal(mapped.get('oai-authenticated-user-id'), 'producer-authority')
  assert.equal(mapped.get('oai-authenticated-user-email'), 'producer@example.test')
  assert.equal(mapped.get('range'), 'bytes=0-9')
})
