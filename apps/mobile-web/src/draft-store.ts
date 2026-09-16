const DRAFT_KEY_PREFIX = 'dsh-remote:draft:'

interface StoredDraft {
  text: string
  version: number
  updatedAt: number
}

export interface DraftStoreOptions {
  storage?: Storage
  now?: () => number
}

function browserStorage(): Storage {
  if (typeof window === 'undefined' || window.localStorage === undefined) {
    throw new Error('DraftStore requires browser storage when no storage is injected')
  }
  return window.localStorage
}

function keyFor(sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}`
}

export class DraftStore {
  private readonly storage: Storage
  private readonly now: () => number

  constructor(options: DraftStoreOptions = {}) {
    this.storage = options.storage ?? browserStorage()
    this.now = options.now ?? Date.now
  }

  get(sessionId: string): string {
    return this.read(sessionId)?.text ?? ''
  }

  version(sessionId: string): number {
    return this.read(sessionId)?.version ?? 0
  }

  set(sessionId: string, text: string): void {
    const previous = this.read(sessionId)
    const next: StoredDraft = {
      text,
      version: (previous?.version ?? 0) + 1,
      updatedAt: this.now(),
    }
    this.storage.setItem(keyFor(sessionId), JSON.stringify(next))
  }

  clearIfVersion(sessionId: string, version: number): boolean {
    const current = this.read(sessionId)
    if (current === undefined || current.version !== version) return false
    this.storage.removeItem(keyFor(sessionId))
    return true
  }

  private read(sessionId: string): StoredDraft | undefined {
    const key = keyFor(sessionId)
    const raw = this.storage.getItem(key)
    if (raw === null) return undefined

    try {
      const value = JSON.parse(raw) as Partial<StoredDraft>
      if (
        typeof value.text !== 'string'
        || typeof value.version !== 'number'
        || !Number.isInteger(value.version)
        || value.version < 1
        || typeof value.updatedAt !== 'number'
      ) {
        throw new Error('invalid draft')
      }
      return value as StoredDraft
    } catch {
      this.storage.removeItem(key)
      return undefined
    }
  }
}
