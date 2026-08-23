import { describe, expect, it, vi } from 'vitest'
import { DirectTailnetTransport } from '../src/index.js'
import type { WebSocketConstructor, WebSocketEventLike, WebSocketLike } from '../src/index.js'

/**
 * A socket that connects at the TCP level and then says nothing, the way an
 * open WebSocket looks once the tailnet drops: no 'open', no 'close', no
 * 'error'. Only the handshake deadline ends the wait.
 */
class SilentSocket implements WebSocketLike {
  readonly readyState = 0
  closeCalls = 0

  constructor(readonly url: string) {}

  addEventListener(_type: string, _listener: (event: WebSocketEventLike) => void): void {
    // Never fires: that is the point.
  }

  close(): void {
    this.closeCalls += 1
  }
}

/** Completes the handshake and then, like an idle host, sends nothing. */
class QuietSocket implements WebSocketLike {
  readonly readyState = 1
  private readonly listeners = new Map<string, Array<(event: WebSocketEventLike) => void>>()

  constructor(readonly url: string) {
    setTimeout(() => this.emit('open'), 0)
  }

  addEventListener(type: string, listener: (event: WebSocketEventLike) => void): void {
    const bucket = this.listeners.get(type) ?? []
    bucket.push(listener)
    this.listeners.set(type, bucket)
  }

  close(): void {
    this.emit('close')
  }

  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type })
  }
}

function transportWith(options: { timeoutMs: number; eventOpenTimeoutMs?: number }): DirectTailnetTransport {
  return new DirectTailnetTransport({
    baseUrl: 'http://127.0.0.1:3090',
    WebSocket: SilentSocket as unknown as WebSocketConstructor,
    ...options,
  })
}

describe('DirectTailnetTransport event handshake', () => {
  it('gives up on a silent handshake at eventOpenTimeoutMs, not the RPC timeout', async () => {
    vi.useFakeTimers()
    try {
      const transport = transportWith({ timeoutMs: 30_000, eventOpenTimeoutMs: 8_000 })
      const pending = transport.events('mux').next()
      const settled = vi.fn()
      void pending.then(settled, settled)

      await vi.advanceTimersByTimeAsync(7_900)
      expect(settled).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(200)
      await expect(pending).rejects.toThrow(/open timed out/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('separates approval idempotency by outcome', async () => {
    const requests: Array<{ idempotencyKey?: string; method: string; requestId: string }> = []
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { idempotencyKey?: string; method: string; requestId: string }
      requests.push(request)
      return new Response(JSON.stringify({
        protocolVersion: 1,
        requestId: request.requestId,
        method: request.method,
        result: { ok: true, value: { accepted: true } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const transport = new DirectTailnetTransport({
      baseUrl: 'http://127.0.0.1:3090',
      fetch: fetchMock as typeof fetch,
      WebSocket: SilentSocket as unknown as WebSocketConstructor,
    })

    await transport.approvalRespond({
      sessionId: 'session_1',
      approvalId: 'approval_1',
      rpcId: 'rpc_1',
      outcome: 'allowed-once',
    })
    await transport.approvalRespond({
      sessionId: 'session_1',
      approvalId: 'approval_1',
      rpcId: 'rpc_1',
      outcome: 'rejected',
    })

    expect(requests.map(request => request.idempotencyKey)).toEqual([
      'approval:session_1:approval_1:rpc_1:allowed-once',
      'approval:session_1:approval_1:rpc_1:rejected',
    ])
  })

  it('reports the handshake before any frame arrives, so an idle host still counts as connected', async () => {
    const transport = new DirectTailnetTransport({
      baseUrl: 'http://127.0.0.1:3090',
      WebSocket: QuietSocket as unknown as WebSocketConstructor,
    })
    const controller = new AbortController()
    let opened = 0
    const iterator = transport.events('mux', controller.signal, () => { opened += 1 })
    const pending = iterator.next()

    await vi.waitFor(() => expect(opened).toBe(1))
    // Still waiting on a first frame that an idle host will never send.
    const raced = await Promise.race([pending.then(() => 'yielded'), Promise.resolve('waiting')])
    expect(raced).toBe('waiting')

    controller.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
  })

  it('falls back to the RPC timeout when no handshake deadline is configured', async () => {
    vi.useFakeTimers()
    try {
      const transport = transportWith({ timeoutMs: 12_000 })
      const pending = transport.events('mux').next()
      const settled = vi.fn()
      void pending.then(settled, settled)

      await vi.advanceTimersByTimeAsync(11_900)
      expect(settled).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(200)
      await expect(pending).rejects.toThrow(/open timed out/)
    } finally {
      vi.useRealTimers()
    }
  })
})
