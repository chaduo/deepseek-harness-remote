import { describe, expect, it } from 'vitest'
import {
  emptyQuestionAnswers,
  offlineProbeDelay,
  questionAnswersForSubmit,
  questionAnswersReady,
  withResolvedApproval,
  withoutPendingApproval,
} from '../src/remote-state.js'
import {
  displayHostName,
  sortTaskChats,
  taskChatsForProject,
  toggleTaskProject,
} from '../src/task-page-model.js'
import { composerCopy } from '../src/composer-model.js'
import type { ApprovalRequest, QuestionRequest } from '@dsh-remote/domain'

const approval: ApprovalRequest = {
  sessionId: 'session_1',
  rpcId: 'rpc_1',
  approvalId: 'approval_1',
  toolName: 'bash',
}

describe('mobile remote state', () => {
  it('formats the task-home host label and sorts chats without mutating input', () => {
    expect(displayHostName('localhost')).toBe('远程 Mac')
    expect(displayHostName('zhaozhuomacbook-pro-2.tailnet.ts.net')).toBe('zhaozhuomacbook-pro-2.local')

    const chats = [
      { sessionId: 'older', updatedAt: 2 },
      { sessionId: 'newer', updatedAt: 5 },
    ]
    expect(sortTaskChats(chats).map(chat => chat.sessionId)).toEqual(['newer', 'older'])
    expect(chats.map(chat => chat.sessionId)).toEqual(['older', 'newer'])
  })

  it('toggles a project and filters its chats by workspace', () => {
    expect(toggleTaskProject([], 'workspace-a')).toEqual(['workspace-a'])
    expect(toggleTaskProject(['workspace-a'], 'workspace-a')).toEqual([])
    expect(toggleTaskProject(['workspace-a'], 'workspace-b')).toEqual(['workspace-a', 'workspace-b'])

    const chats = [
      { sessionId: 'a-1', workspaceId: 'workspace-a', updatedAt: 2 },
      { sessionId: 'b-1', workspaceId: 'workspace-b', updatedAt: 3 },
      { sessionId: 'a-2', workspaceId: 'workspace-a', updatedAt: 5 },
    ]
    expect(taskChatsForProject(chats, 'workspace-a').map(chat => chat.sessionId)).toEqual(['a-2', 'a-1'])
  })

  it('keeps the composer action copy aligned with the session state', () => {
    expect(composerCopy(false, false)).toEqual({
      placeholder: '发送下一条指令…',
      sendLabel: '发送指令',
      mode: 'queue',
    })
    expect(composerCopy(true, false)).toEqual({
      placeholder: '追加说明或调整方向…',
      sendLabel: '立即追加',
      mode: 'steer',
    })
    expect(composerCopy(true, true)).toEqual({
      placeholder: '追加说明或调整方向…',
      sendLabel: '发送中…',
      mode: 'steer',
    })
  })

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

  it('allows a complete question batch to submit with intentionally skipped answers', () => {
    const request: QuestionRequest = {
      sessionId: 'session_1',
      rpcId: 'question_1',
      questions: [
        { id: 'choice', question: '范围？', options: [{ label: '全部' }, { label: '部分' }] },
        { id: 'note', question: '补充说明（可留空）' },
      ],
    }

    expect(questionAnswersReady(request, [
      { id: 'choice', selected: ['全部'] },
      { id: 'note', selected: [] },
    ])).toBe(true)
    expect(questionAnswersReady(request, [{ id: 'choice', selected: ['全部'] }])).toBe(false)
  })

  it('keeps skipped answers empty and makes custom text exclusive for a single choice', () => {
    const request: QuestionRequest = {
      sessionId: 'session_1',
      rpcId: 'question_1',
      questions: [
        { id: 'choice', question: '范围？', options: [{ label: '全部' }, { label: '部分' }] },
        { id: 'note', question: '补充说明（可留空）' },
        { id: 'tags', question: '标签？', multiSelect: true, options: [{ label: 'UI' }] },
      ],
    }

    expect(questionAnswersForSubmit(request, [
      { id: 'choice', selected: ['全部'] },
      { id: 'note', selected: [] },
      { id: 'tags', selected: ['UI'] },
    ], {
      choice: '自定义范围',
      note: '   ',
      tags: '移动端',
    })).toEqual([
      { id: 'choice', selected: [], custom: '自定义范围' },
      { id: 'note', selected: [] },
      { id: 'tags', selected: ['UI'], custom: '移动端' },
    ])
  })

  it('backs offline probes off to a sixty-second cap', () => {
    expect([0, 1, 2, 3, 8].map(offlineProbeDelay)).toEqual([15_000, 30_000, 60_000, 60_000, 60_000])
  })
})
