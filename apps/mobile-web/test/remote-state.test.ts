import { describe, expect, it } from 'vitest'
import {
  emptyQuestionAnswers,
  offlineProbeDelay,
  withResolvedApproval,
  withoutPendingApproval,
} from '../src/remote-state.js'
import type { ApprovalRequest, QuestionRequest } from '@dsh-remote/domain'

const approval: ApprovalRequest = {
  sessionId: 'session_1',
  rpcId: 'rpc_1',
  approvalId: 'approval_1',
  toolName: 'bash',
}

describe('mobile remote state', () => {
  it('clears an acknowledged approval and records its visible outcome immediately', () => {
    expect(withoutPendingApproval([approval], approval.approvalId)).toEqual([])
    expect(withResolvedApproval([], approval, 'allowed-once', undefined, '2026-08-22T00:00:00.000Z'))
      .toEqual([{
        request: approval,
        outcome: 'allowed-once',
        resolvedAt: '2026-08-22T00:00:00.000Z',
      }])
  })

  it('deduplicates a later approval/resolved event', () => {
    const first = withResolvedApproval([], approval, 'allowed-once', undefined, '2026-08-22T00:00:00.000Z')
    expect(withResolvedApproval(first, approval, 'allowed-once', undefined, '2026-08-22T00:00:01.000Z'))
      .toEqual(first)
  })

  it('does not preselect an Agent question answer', () => {
    const request: QuestionRequest = {
      sessionId: 'session_1',
      rpcId: 'question_1',
      questions: [{ id: 'q1', question: '范围？', options: [{ label: '全部' }, { label: '部分' }] }],
    }
    expect(emptyQuestionAnswers(request)).toEqual([{ id: 'q1', selected: [] }])
  })

  it('backs offline probes off to a sixty-second cap', () => {
    expect([0, 1, 2, 3, 8].map(offlineProbeDelay)).toEqual([15_000, 30_000, 60_000, 60_000, 60_000])
  })
})
