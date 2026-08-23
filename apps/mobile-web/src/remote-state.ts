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

/**
 * Harness requires one answer item per question, but an item may intentionally
 * be skipped with an empty `selected` array and no `custom` value.
 */
export function questionAnswersReady(
  request: QuestionRequest,
  answers: readonly QuestionAnswerItem[],
): boolean {
  return request.questions.every(question => answers.some(answer => answer.id === question.id))
}

export function questionAnswersForSubmit(
  request: QuestionRequest,
  answers: readonly QuestionAnswerItem[],
  customByQuestionId: Readonly<Record<string, string>>,
): QuestionAnswerItem[] {
  return answers.map(answer => {
    const custom = customByQuestionId[answer.id]?.trim()
    if (custom === undefined || custom === '') return { ...answer }
    const question = request.questions.find(item => item.id === answer.id)
    return {
      ...answer,
      selected: question?.multiSelect === true ? [...answer.selected] : [],
      custom,
    }
  })
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
  return [resolvedApproval(request, outcome, display, resolvedAt), ...previous].slice(0, 20)
}

export function resolvedApproval(
  request: ApprovalRequest,
  outcome: string,
  display: ApprovalDisplay | undefined,
  resolvedAt: string,
): ResolvedApproval {
  return {
    request,
    outcome,
    ...(display !== undefined && { display }),
    resolvedAt,
  }
}
