import type { RemoteRpcResponse } from '@dsh-remote/protocol'

export interface IdempotencyStoreOptions {
  ttlMs?: number
  now?: () => number
}

interface CompletedEntry {
  state: 'completed'
  result: RemoteRpcResponse['result']
  expiresAt: number
}

interface PendingEntry {
  state: 'pending'
  promise: Promise<RemoteRpcResponse['result']>
}

type Entry = CompletedEntry | PendingEntry

export interface IdempotencyRunResult {
  result: RemoteRpcResponse['result']
  replayed: boolean
}

/**
 * In-memory duplicate guard for remote write RPCs. The guard is process-local;
 * a future relay deployment can move the same key/value shape to the server.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: IdempotencyStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000
    this.now = options.now ?? Date.now
  }

  get(key: string): RemoteRpcResponse['result'] | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined || entry.state === 'pending') return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.result
  }

  set(key: string, result: RemoteRpcResponse['result']): void {
    this.prune()
    this.entries.set(key, {
      state: 'completed',
      result,
      expiresAt: this.now() + this.ttlMs,
    })
  }

  /**
   * Runs an operation at most once for a key, including while the first call is
   * still in flight. Failed operations are removed so a later retry can make a
   * fresh attempt; successful results remain replayable for the configured TTL.
   */
  async run(
    key: string,
    operation: () => Promise<RemoteRpcResponse['result']>,
  ): Promise<IdempotencyRunResult> {
    this.prune()
    const existing = this.entries.get(key)
    if (existing?.state === 'pending') {
      return { result: await existing.promise, replayed: true }
    }
    if (existing?.state === 'completed') {
      return { result: existing.result, replayed: true }
    }

    // Defer the operation to a microtask so the pending entry is visible before
    // adapter code can settle or a concurrent request can inspect the store.
    const promise = Promise.resolve().then(operation)
    const pending: PendingEntry = { state: 'pending', promise }
    this.entries.set(key, pending)

    try {
      const result = await promise
      if (this.entries.get(key) === pending) {
        this.entries.set(key, {
          state: 'completed',
          result,
          expiresAt: this.now() + this.ttlMs,
        })
      }
      return { result, replayed: false }
    } catch (error) {
      if (this.entries.get(key) === pending) this.entries.delete(key)
      throw error
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.state === 'completed' && entry.expiresAt <= now) this.entries.delete(key)
    }
  }
}
