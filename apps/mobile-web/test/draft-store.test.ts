import { describe, expect, it } from 'vitest'
import { DraftStore } from '../src/draft-store.js'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('DraftStore', () => {
  it('keeps independent drafts for two sessions', () => {
    const store = new DraftStore({ storage: new MemoryStorage() })

    store.set('session-a', 'first')
    store.set('session-b', 'second')

    expect(store.get('session-a')).toBe('first')
    expect(store.get('session-b')).toBe('second')
  })

  it('does not clear newer text after an older send succeeds', () => {
    const store = new DraftStore({ storage: new MemoryStorage() })

    store.set('session-a', 'old')
    const submittedVersion = store.version('session-a')
    store.set('session-a', 'new')

    expect(store.clearIfVersion('session-a', submittedVersion)).toBe(false)
    expect(store.get('session-a')).toBe('new')
  })

  it('restores a draft from storage after a new store is created', () => {
    const storage = new MemoryStorage()
    const first = new DraftStore({ storage })
    first.set('session-a', 'survives refresh')

    const second = new DraftStore({ storage })

    expect(second.get('session-a')).toBe('survives refresh')
    expect(second.version('session-a')).toBe(1)
  })

  it('clears only the version that was submitted', () => {
    const store = new DraftStore({ storage: new MemoryStorage() })

    store.set('session-a', 'submit me')
    const submittedVersion = store.version('session-a')

    expect(store.clearIfVersion('session-a', submittedVersion)).toBe(true)
    expect(store.get('session-a')).toBe('')
    expect(store.version('session-a')).toBe(0)
  })
})
