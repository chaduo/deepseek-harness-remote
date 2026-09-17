import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type {
  DeepSeekHarnessAdapterOptions,
  WebSocketConstructor,
  WebSocketLike,
} from '../src/index.js'
import { DeepSeekHarnessAdapter, HarnessAdapterError } from '../src/index.js'

type MuxOpenFrame = { type: 'open'; streamId: string; endpoint: string; payload: unknown }

let fakeWebSocketAutoOpen = true
let fakeWebSocketOnSend: ((socket: FakeWebSocket, frame: MuxOpenFrame | { type: 'cancel'; streamId: string }) => void) | undefined

class FakeWebSocket implements WebSocketLike {
  readyState = 1
  sent: string[] = []
  private listeners = new Map<string, Array<(event: { type: string; data?: unknown }) => void>>()

  constructor() {
    if (fakeWebSocketAutoOpen) queueMicrotask(() => this.emit('open'))
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { type: string; data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  send(data: string): void {
    this.sent.push(data)
    fakeWebSocketOnSend?.(this, JSON.parse(data) as MuxOpenFrame | { type: 'cancel'; streamId: string })
  }

  close(): void {
    if (this.readyState !== 3) {
      this.readyState = 3
      this.emit('close')
    }
  }

  emit(type: 'open' | 'message' | 'close' | 'error', data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, data })
  }
}

interface FakeWebSocketConstructor extends WebSocketConstructor {
  last: FakeWebSocket | undefined
  lastOptions: { headers?: Record<string, string> } | undefined
}

const FakeWebSocketCtor = class extends FakeWebSocket {
  static last: FakeWebSocket | undefined
  static lastOptions: { headers?: Record<string, string> } | undefined

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    super()
    void url
    FakeWebSocketCtor.lastOptions = options ?? {}
    FakeWebSocketCtor.last = this
  }
} as FakeWebSocketConstructor

function adapterWith(overrides: Partial<DeepSeekHarnessAdapterOptions> = {}): DeepSeekHarnessAdapter {
  return new DeepSeekHarnessAdapter({
    baseUrl: 'https://harness.test',
    hostId: 'host_1',
    newId: (() => {
      let id = 0
      return () => `id-${++id}`
    })(),
    ...overrides,
  })
}

function muxItem(socket: FakeWebSocket, streamId: string, value: unknown): void {
  socket.emit('message', JSON.stringify({ type: 'item', streamId, value }))
}

function muxEnd(socket: FakeWebSocket, streamId: string): void {
  socket.emit('message', JSON.stringify({ type: 'end', streamId }))
}

function response(value: unknown): Response {
  return new Response(JSON.stringify({
    type: 'server-response',
    rpcId: 'upstream-rpc',
    result: { ok: true, value },
  }), { status: 200 })
}

beforeEach(() => {
  fakeWebSocketAutoOpen = true
  fakeWebSocketOnSend = undefined
  FakeWebSocketCtor.last = undefined
  FakeWebSocketCtor.lastOptions = undefined
})

describe('DeepSeekHarnessAdapter', () => {
  it('uses the current slash endpoint and args envelope for session listing', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    fakeWebSocketOnSend = (socket, frame) => {
      if (frame.type === 'open' && frame.endpoint === 'workspace/follow') {
        muxItem(socket, frame.streamId, { type: 'baseline', value: { items: [], archivedSessionIds: [] } })
        muxEnd(socket, frame.streamId)
      }
    }
    const adapter = adapterWith({
      WebSocket: FakeWebSocketCtor,
      fetch: (async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
        return response({ items: [] })
      }) as typeof fetch,
    })

    await expect(adapter.sessionList()).resolves.toEqual([])
    expect(requests[0]?.url).toBe('https://harness.test/api/session/list')
    expect(requests[0]?.body).toMatchObject({
      type: 'client-request',
      method: 'session/list',
      payload: { args: { _request: {} } },
    })
  })

  it('derives the host descriptor from the current session projection', async () => {
    const adapter = adapterWith({
      fetch: (async () => response({
        items: [{
          sessionId: 'session_1',
          cwd: '/repo',
          projections: { values: { modelSelection: { lastUsed: { provider: 'deepseek', model: 'v4-pro' } } } },
        }],
      })) as typeof fetch,
    })

    await expect(adapter.hostDescribe()).resolves.toMatchObject({
      hostId: 'host_1',
      cwd: '/repo',
      provider: 'deepseek',
      model: 'v4-pro',
      attachedSessions: 1,
    })
  })

  it('bootstraps a browser session for HTTP and WebSocket calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-harness-auth-'))
    const authUrlFile = join(directory, 'auth-url')
    await writeFile(authUrlFile, 'http://harness.test/?token=launch-token\n', 'utf8')
    const requests: Array<{ url: string; headers: Headers }> = []
    fakeWebSocketOnSend = (socket, frame) => {
      if (frame.type === 'open' && frame.endpoint === '$events') {
        muxItem(socket, frame.streamId, { type: 'ready', clientId: 'client-1', host: { home: '/tmp' } })
        muxEnd(socket, frame.streamId)
      }
    }

    try {
      const adapter = adapterWith({
        authUrlFile,
        WebSocket: FakeWebSocketCtor,
        fetch: (async (url, init) => {
          const requestUrl = String(url)
          requests.push({ url: requestUrl, headers: new Headers(init?.headers) })
          if (requestUrl === 'http://harness.test/?token=launch-token') {
            return new Response(null, {
              status: 303,
              headers: { 'set-cookie': 'dsh_session=session-cookie; Path=/; HttpOnly' },
            })
          }
          return response({ items: [] })
        }) as typeof fetch,
      })

      await adapter.hostDescribe()
      expect(requests.map(request => request.url)).toEqual([
        'http://harness.test/?token=launch-token',
        'https://harness.test/api/session/list',
      ])
      expect(requests[1]?.headers.get('cookie')).toBe('dsh_session=session-cookie')

      const stream = adapter.hostEvents()
      await expect(stream.next()).resolves.toMatchObject({ done: true })
      expect(FakeWebSocketCtor.lastOptions?.headers?.cookie).toBe('dsh_session=session-cookie')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('throws a HarnessAdapterError for upstream RPC failures', async () => {
    const adapter = adapterWith({
      fetch: (async () => new Response(JSON.stringify({
        type: 'server-response',
        rpcId: 'id-1',
        result: { ok: false, error: { code: 'bad-request', message: 'nope', details: {} } },
      }), { status: 200 })) as typeof fetch,
    })

    await expect(adapter.hostDescribe()).rejects.toBeInstanceOf(HarnessAdapterError)
  })

  it('maps the safe preset roster without exposing authoring fields', async () => {
    const adapter = adapterWith({
      fetch: (async () => response({
        presets: [{
          id: 'standard',
          trust: 'system',
          isDefault: true,
          name: '标准',
          description: '完整编码能力',
        }],
        authorable: true,
        hasDocument: true,
      })) as typeof fetch,
    })

    await expect(adapter.agentPresetList()).resolves.toEqual([{
      id: 'standard',
      trust: 'system',
      isDefault: true,
      name: '标准',
      description: '完整编码能力',
    }])
  })

  it('preserves the workspace archive baseline for remote list filtering', async () => {
    fakeWebSocketOnSend = (socket, frame) => {
      if (frame.type === 'open' && frame.endpoint === 'workspace/follow') {
        muxItem(socket, frame.streamId, {
          type: 'baseline',
          value: {
            items: [{
              workspaceId: 'ws_1',
              path: '/repo',
              title: 'repo',
              sessionIds: ['session_1'],
              createdAt: '2026-08-22T00:00:00.000Z',
              updatedAt: '2026-08-22T00:00:00.000Z',
            }],
            archivedSessionIds: ['session_archived'],
          },
        })
        muxEnd(socket, frame.streamId)
      }
    }
    const adapter = adapterWith({ WebSocket: FakeWebSocketCtor })

    await expect(adapter.workspaceList()).resolves.toMatchObject({
      items: [{ workspaceId: 'ws_1', path: '/repo', title: 'repo' }],
      archivedSessionIds: ['session_archived'],
    })
  })

  it('forwards complete session model selections to the upstream RPC', async () => {
    const requests: Array<{ method: string; payload: unknown }> = []
    const adapter = adapterWith({
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; payload: unknown }
        requests.push(request)
        return response({ selected: { provider: 'deepseek', model: 'v4-pro', reasoningEffort: 'max' } })
      }) as typeof fetch,
    })

    await adapter.sessionSelectModel({
      sessionId: 'session_1',
      provider: 'deepseek',
      model: 'v4-pro',
      reasoningEffort: 'max',
    })
    expect(requests[0]).toMatchObject({
      method: 'session/selectModel',
      payload: {
        args: {
          request: {
            sessionId: 'session_1',
            provider: 'deepseek',
            model: 'v4-pro',
            reasoningEffort: 'max',
          },
        },
      },
    })
  })

  it('sends an approval result through the current Remote Event RPC', async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    fakeWebSocketOnSend = (socket, frame) => {
      if (frame.type === 'open' && frame.endpoint === '$events') {
        muxItem(socket, frame.streamId, { type: 'ready', clientId: 'client-1', host: { home: '/tmp' } })
        muxItem(socket, frame.streamId, {
          type: 'waterfall',
          event: 'approval/request',
          eventId: 'event-1',
          agentId: 'session_1',
          request: { toolName: 'terminal', reason: '需要执行命令' },
        })
      }
    }
    const adapter = adapterWith({
      WebSocket: FakeWebSocketCtor,
      fetch: (async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
        return response(undefined)
      }) as typeof fetch,
    })

    const stream = adapter.hostEvents()
    const request = (await stream.next()).value
    expect(request).toMatchObject({ method: 'approval/requested', rpcId: 'event-1' })

    await expect(adapter.approvalRespond('event-1', {
      sessionId: 'session_1',
      rpcId: 'event-1',
      approvalId: 'event-1',
      outcome: 'allowed-once',
    })).resolves.toEqual({ accepted: true })
    expect(requests[0]).toMatchObject({
      url: 'https://harness.test/api/$events/result',
      body: {
        method: '$events/result',
        payload: {
          args: {
            clientId: 'client-1',
            eventId: 'event-1',
            outcome: { kind: 'result', value: 'allowed-once' },
          },
        },
      },
    })
    await stream.return?.(undefined)
  })

  it('normalizes current Host event frames into remote notifications', async () => {
    fakeWebSocketOnSend = (socket, frame) => {
      if (frame.type === 'open' && frame.endpoint === '$events') {
        muxItem(socket, frame.streamId, { type: 'ready', clientId: 'client-1', host: { home: '/tmp' } })
        muxItem(socket, frame.streamId, {
          type: 'emit',
          event: 'api-session/activity',
          args: ['session_1', 42],
        })
      }
    }
    const adapter = adapterWith({ WebSocket: FakeWebSocketCtor })
    const stream = adapter.hostEvents()

    await expect(stream.next()).resolves.toMatchObject({
      value: {
        method: 'session/activity',
        payload: { type: 'session/activity', sessionId: 'session_1', updatedAt: 42 },
      },
    })
    await stream.return?.(undefined)
  })

  it('forwards durable events from the current session follow stream', async () => {
    fakeWebSocketOnSend = (socket, frame) => {
      if (frame.type !== 'open') return
      if (frame.endpoint === '$events') {
        muxItem(socket, frame.streamId, { type: 'ready', clientId: 'client-1', host: { home: '/tmp' } })
      } else if (frame.endpoint === 'session/control') {
        muxItem(socket, frame.streamId, { type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } })
        muxEnd(socket, frame.streamId)
      } else if (frame.endpoint === 'session/follow') {
        muxItem(socket, frame.streamId, {
          type: 'snapshot',
          header: { version: 3, id: 'session_1', createdAt: 0, isSeeded: false },
          cursor: 4,
          records: [],
          hasMore: false,
          projections: { asOfSeq: 4, values: {} },
        })
        muxItem(socket, frame.streamId, {
          type: 'event',
          event: { type: 'assistant/message', seq: 5, time: 1_700_000_000_000, data: { text: '完成' } },
        })
      }
    }
    const controller = new AbortController()
    const adapter = adapterWith({
      WebSocket: FakeWebSocketCtor,
      fetch: (async () => response({ items: [{ sessionId: 'session_1' }] })) as typeof fetch,
    })
    const stream = adapter.muxEvents(controller.signal)

    const result = await stream.next()
    expect(result).toMatchObject({
      value: {
        method: 'session/event',
        payload: {
          type: 'session/event',
          sessionId: 'session_1',
          event: { type: 'assistant/message', seq: 5, data: { text: '完成' } },
        },
      },
    })
    controller.abort()
    await stream.return?.(undefined)
  })

  it('stops a stream cleanly when aborted before the WebSocket opens', async () => {
    fakeWebSocketAutoOpen = false
    const controller = new AbortController()
    const adapter = adapterWith({ WebSocket: FakeWebSocketCtor })
    const stream = adapter.hostEvents(controller.signal)
    const next = stream.next()
    await Promise.resolve()
    controller.abort()

    await expect(next).resolves.toMatchObject({ done: true })
  })
})
