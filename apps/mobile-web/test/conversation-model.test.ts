import { describe, expect, it } from 'vitest'
import type { ReviewNode } from '@dsh-remote/domain'
import {
  compactConversationText,
  compactReasoningLabel,
  conversationNodes,
} from '../src/conversation-model.js'

describe('conversation presentation model', () => {
  it('keeps user, agent, and tool entries in timeline order', () => {
    const nodes: ReviewNode[] = [
      { kind: 'turn', turn: 1, seq: 1, timestamp: '2026-09-17T00:00:01.000Z' },
      { kind: 'message', role: 'user', text: '先检查项目', seq: 2, timestamp: '2026-09-17T00:00:02.000Z' },
      { kind: 'status', eventType: 'permission/preset', label: '权限策略', detail: '', payload: {}, seq: 3, timestamp: '2026-09-17T00:00:03.000Z' },
      { kind: 'tool', name: 'bash', title: '检查文件', seq: 4, timestamp: '2026-09-17T00:00:04.000Z' },
      { kind: 'message', role: 'assistant', text: '检查完成', seq: 5, timestamp: '2026-09-17T00:00:05.000Z' },
    ]

    expect(conversationNodes(nodes).map(node => `${node.kind}:${node.seq}`)).toEqual([
      'message:2',
      'tool:4',
      'message:5',
    ])
  })

  it('returns a compact preview for long conversation text', () => {
    expect(compactConversationText('123456789', 5)).toEqual({ text: '12345…', truncated: true })
    expect(compactConversationText('简短内容', 20)).toEqual({ text: '简短内容', truncated: false })
  })

  it('labels reasoning as folded without putting the reasoning into the conversation preview', () => {
    expect(compactReasoningLabel('想一想\n再检查一下')).toBe('思考过程已折叠 · 8 字')
    expect(compactReasoningLabel('   ')).toBe('')
  })
})
