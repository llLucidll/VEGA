import type { WardenDecision } from '../contracts/vega'

type PendingApproval = WardenDecision & {
  requires_human_approval: true
  approval_status: 'pending'
  execution_status: 'awaiting_authorization'
}

export function isWardenApprovalPending(decision: WardenDecision | null): decision is PendingApproval {
  return decision?.requires_human_approval === true &&
    decision.approval_status === 'pending' &&
    decision.execution_status === 'awaiting_authorization'
}

export function isWardenApprovalExpired(decision: WardenDecision, now: number): boolean {
  const expiresAt = Date.parse(decision.expires_at)
  return !Number.isFinite(expiresAt) || expiresAt <= now
}
