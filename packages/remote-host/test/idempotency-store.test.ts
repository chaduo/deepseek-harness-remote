import { describe, expect, it } from 'vitest'
import { IdempotencyStore } from '../src/idempotency-store.js'

describe('IdempotencyStore', () => {
  it('replays stored successful results for duplicate keys', () => {
    let now = 1_000_000
    const store = new IdempotencyStore({ ttlMs: 1000, now: () => now })
    const result = { ok: true, value: { accepted: true } } as const

    expect(store.get('key_1')).toBeUndefined()
    store.set('key_1', result)
    expect(store.get('key_1')).toEqual(result)
  })

  it('expires entries after the ttl', () => {
    let now = 0
    const store = new IdempotencyStore({ ttlMs: 10, now: () => now })
    store.set('key_1', { ok: true, value: {} })
    now = 11
    expect(store.get('key_1')).toBeUndefined()
  })

  it('does not store failures implicitly', () => {
    const store = new IdempotencyStore()
    expect(store.get('missing')).toBeUndefined()
  })

  it('coalesces concurrent executions for the same key', async () => {
    const store = new IdempotencyStore()
    const result = { ok: true, value: { sessionId: 'session_1' } } as const
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const operation = async () => {
      calls += 1
      await gate
      return result
    }

    const first = store.run('key_1', operation)
    const duplicate = store.run('key_1', operation)
    await Promise.resolve()

    expect(calls).toBe(1)
    release?.()
    await expect(first).resolves.toEqual({ result, replayed: false })
    await expect(duplicate).resolves.toEqual({ result, replayed: true })
  })

  it('allows a retry after the in-flight operation fails', async () => {
    const store = new IdempotencyStore()
    let calls = 0

    await expect(store.run('key_1', async () => {
      calls += 1
      throw new Error('temporary failure')
    })).rejects.toThrow('temporary failure')

    const result = { ok: true, value: { accepted: true } } as const
    await expect(store.run('key_1', async () => {
      calls += 1
      return result
    })).resolves.toEqual({ result, replayed: false })
    expect(calls).toBe(2)
  })
})
