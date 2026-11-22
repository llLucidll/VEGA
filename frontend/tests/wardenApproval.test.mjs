import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isWardenApprovalExpired, isWardenApprovalPending } from '../src/engine/wardenApproval.ts'

const pending = {
  requires_human_approval: true,
  approval_status: 'pending',
  execution_status: 'awaiting_authorization',
  expires_at: '2026-12-01T12:00:00Z',
}

test('only a pending human decision accepts operator input', () => {
  assert.equal(isWardenApprovalPending(pending), true)
  assert.equal(isWardenApprovalPending(null), false)
  assert.equal(isWardenApprovalPending({ ...pending, requires_human_approval: false }), false)
  assert.equal(isWardenApprovalPending({ ...pending, approval_status: 'approved' }), false)
  for (const execution_status of ['executing', 'contained', 'contained_dry_run', 'denied']) {
    assert.equal(isWardenApprovalPending({ ...pending, execution_status }), false)
  }
})

test('live approvals expire at the server deadline or when the deadline is invalid', () => {
  const deadline = Date.parse(pending.expires_at)
  assert.equal(isWardenApprovalExpired(pending, deadline - 1), false)
  assert.equal(isWardenApprovalExpired(pending, deadline), true)
  assert.equal(isWardenApprovalExpired({ ...pending, expires_at: 'invalid' }, deadline), true)
})
