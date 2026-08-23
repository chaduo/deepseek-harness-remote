import type { ApprovalRequest, QuestionAnswerItem, QuestionRequest } from '@dsh-remote/domain'

export interface ApprovalDisplay {
  request: ApprovalRequest
  toolTitle: string
  argumentsText?: string
  callView?: unknown
}

export interface ResolvedApproval {
  request: ApprovalRequest
  outcome: string
  display?: ApprovalDisplay
  resolvedAt: string
}

export const OFFLINE_PROBE_DELAYS_MS = [15_000, 30_000, 60_000] as const

export function offlineProbeDelay(attempt: number): number {
  return OFFLINE_PROBE_DELAYS_MS[Math.min(attempt, OFFLINE_PROBE_DELAYS_MS.length - 1)] ?? 60_000
}

export function emptyQuestionAnswers(request: QuestionRequest): QuestionAnswerItem[] {
  return request.questions.map(question => ({ id: question.id, selected: [] }))
}

export function withoutPendingApproval(
  pending: readonly ApprovalRequest[],
  approvalId: string,
): ApprovalRequest[] {
  return pending.filter(item => item.approvalId !== approvalId)
}

export function withResolvedApproval(
  previous: readonly ResolvedApproval[],
  request: ApprovalRequest,
  outcome: string,
  display: ApprovalDisplay | undefined,
  resolvedAt: string,
): ResolvedApproval[] {
  if (previous.some(item => item.request.approvalId === request.approvalId)) return [...previous]
  return [{
    request,
    outcome,
    ...(display !== undefined && { display }),
    resolvedAt,
  }, ...previous].slice(0, 20)
}
