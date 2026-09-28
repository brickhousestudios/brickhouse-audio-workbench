import assert from 'node:assert/strict'
import test from 'node:test'
import { isSubmissionAccessEnabled, verifySubmissionAccessCode } from '../lib/submission-access.ts'

const enabled = {
  BRICKHOUSE_SUBMISSION_ACCESS_ENABLED: '1',
  BRICKHOUSE_SUBMISSION_ACCESS_CODE: 'judge-code-123',
  BRICKHOUSE_SUBMISSION_USER_ID: 'submission-judge',
  BRICKHOUSE_SUBMISSION_USER_EMAIL: 'judge@example.test',
}

test('submission access stays disabled unless every server-side requirement is present', () => {
  assert.equal(isSubmissionAccessEnabled({}), false)
  assert.equal(isSubmissionAccessEnabled({ ...enabled, BRICKHOUSE_SUBMISSION_ACCESS_ENABLED: '0' }), false)
  assert.equal(isSubmissionAccessEnabled({ ...enabled, BRICKHOUSE_SUBMISSION_ACCESS_CODE: '' }), false)
  assert.equal(isSubmissionAccessEnabled({ ...enabled, BRICKHOUSE_SUBMISSION_USER_ID: '' }), false)
  assert.equal(isSubmissionAccessEnabled({ ...enabled, BRICKHOUSE_SUBMISSION_USER_EMAIL: '' }), false)
  assert.equal(isSubmissionAccessEnabled(enabled), true)
})

test('submission access code is exact and fails closed', () => {
  assert.equal(verifySubmissionAccessCode(undefined, enabled), false)
  assert.equal(verifySubmissionAccessCode('judge-code-12', enabled), false)
  assert.equal(verifySubmissionAccessCode('judge-code-124', enabled), false)
  assert.equal(verifySubmissionAccessCode(' judge-code-123 ', enabled), false)
  assert.equal(verifySubmissionAccessCode('judge-code-123', enabled), true)
})
