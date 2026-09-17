import type { ReviewMessageNode, ReviewNode, ReviewToolNode } from '@dsh-remote/domain'

export type ConversationNode = ReviewMessageNode | ReviewToolNode

export function conversationNodes(nodes: readonly ReviewNode[]): ConversationNode[] {
  return nodes.filter((node): node is ConversationNode => node.kind === 'message' || node.kind === 'tool')
}

export function compactConversationText(text: string, limit = 360): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: `${text.slice(0, limit)}…`, truncated: true }
}

export function compactReasoningLabel(reasoning: string): string {
  const count = Array.from(reasoning.replace(/\s+/g, '')).length
  return count === 0 ? '' : `思考过程已折叠 · ${count} 字`
}
