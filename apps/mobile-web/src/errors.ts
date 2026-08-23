export interface UserFeedback {
  summary: string
  action?: string
  detail?: string
}

/** Removes transport/adapter routing prefixes while preserving the root cause. */
export function innermostReason(reason: string): string {
  return reason.replace(/^remote RPC [\w.-]+: (upstream RPC [\w.-]+ failed: )?/, '')
}

export function feedbackFor(
  cause: unknown,
  summary: string,
  action?: string,
): UserFeedback {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const detail = innermostReason(raw)
  return {
    summary,
    ...(action !== undefined && { action }),
    ...(detail.trim() !== '' && { detail }),
  }
}
