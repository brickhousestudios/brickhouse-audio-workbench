import assert from 'node:assert/strict'
import test from 'node:test'
import { applyAuthIdentityClaims } from '../lib/auth-identity.ts'

test('GitHub login clears stale submission judge identity', () => {
  const token = { submissionAccess: true }
  assert.deepEqual(
    applyAuthIdentityClaims(token, { provider: 'github', providerAccountId: '123456' }, { id: 'github-user' }),
    { githubSub: '123456' },
  )
})

test('judge login clears stale GitHub identity', () => {
  const token = { githubSub: '123456' }
  assert.deepEqual(
    applyAuthIdentityClaims(token, { provider: 'judge-access' }, { id: 'brickhouse-submission-judge' }),
    { submissionAccess: true },
  )
})

test('invalid judge login leaves no producer or submission identity claim', () => {
  const token = { githubSub: '123456', submissionAccess: true }
  assert.deepEqual(applyAuthIdentityClaims(token, { provider: 'judge-access' }, { id: 'wrong-user' }), {})
})
