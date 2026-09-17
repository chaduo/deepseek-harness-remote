/**
 * Small presentation helpers for the task home. Keeping these decisions out
 * of the JSX makes the mobile layout deterministic and easy to exercise.
 */

export function displayHostName(hostname: string): string {
  const normalized = hostname.trim().toLowerCase()
  if (normalized === '' || normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return '远程 Mac'
  }

  const firstLabel = normalized.split('.')[0] ?? ''
  return firstLabel === '' ? '远程 Mac' : `${firstLabel}.local`
}

export function sortTaskChats<T extends { updatedAt: number }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => right.updatedAt - left.updatedAt)
}
