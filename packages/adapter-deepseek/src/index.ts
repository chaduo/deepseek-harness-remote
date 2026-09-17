import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  AgentPresetOption,
  AgentPresetSelectInput,
  ApprovalDecision,
  HostDescriptor,
  PromptInput,
  QuestionDecision,
  SessionCreateInput,
  SessionEventView,
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionModels,
  SessionModelSelectInput,
  SessionSummary,
  WorkspaceCreateInput,
  WorkspaceListResult,
  WorkspaceSummary,
} from '@dsh-remote/domain'
import type { EventId, HostId } from '@dsh-remote/protocol'
import NodeWebSocket from 'ws'

/**
 * The only package that knows the DeepSeek Harness upstream wire contract.
 *
 * This package consumes the HTTP RPC and the two downlink WebSocket endpoints
 * exposed by DeepSeek Harness. The upstream project is a developer preview,
 * so every call and every frame type lives behind this adapter.
 */

export interface HarnessRpcError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export type HarnessRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HarnessRpcError }

export interface HarnessServerRequest {
  type: 'server-request'
  rpcId: string
  method: string
  payload: unknown
}

interface HarnessClientRequest {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

interface HarnessServerResponse<T> {
  type: 'server-response'
  rpcId: string
  result: HarnessRpcResult<T>
}

export interface WebSocketLike {
  readonly readyState: number
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: WebSocketEventLike) => void): void
  send(data: string): void
  close(): void
}

export interface WebSocketEventLike {
  type: string
  data?: unknown
}

export interface WebSocketOptions {
  headers?: Record<string, string>
}

export type WebSocketConstructor = new (url: string, options?: WebSocketOptions) => WebSocketLike

export interface DeepSeekHarnessAdapterOptions {
  baseUrl: string
  /** Stable id for the Mac host; also used to derive deterministic event ids. */
  hostId: HostId
  /** Full authenticated dsh web URL, normally read from the LaunchAgent auth file. */
  authUrl?: string
  /** File containing the full authenticated dsh web URL printed at startup. */
  authUrlFile?: string
  /** Optional 0600 file used to cache the exchanged browser-session cookie. */
  authCookieFile?: string
  fetch?: typeof fetch
  WebSocket?: WebSocketConstructor
  newId?: () => string
  timeoutMs?: number
}

export class HarnessAdapterError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'protocol' | 'rpc',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'HarnessAdapterError'
  }
}

class NodeWebSocketLike implements WebSocketLike {
  constructor(private readonly socket: NodeWebSocket) {}

  get readyState(): number {
    return this.socket.readyState
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: WebSocketEventLike) => void): void {
    if (type === 'message') {
      this.socket.on('message', data => listener({ type, data: data.toString() }))
      return
    }
    this.socket.on(type, () => listener({ type }))
  }

  send(data: string): void {
    this.socket.send(data)
  }

  close(): void {
    this.socket.close()
  }
}

const DefaultWebSocket = class extends NodeWebSocketLike {
  constructor(url: string, options?: WebSocketOptions) {
    super(new NodeWebSocket(url, options))
  }
} as WebSocketConstructor

export class DeepSeekHarnessAdapter {
  private readonly baseUrl: string
  private readonly hostId: HostId
  private readonly authUrl: string | undefined
  private readonly authUrlFile: string | undefined
  private readonly authCookieFile: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly WebSocketImpl: WebSocketConstructor
  private readonly newId: () => string
  private readonly timeoutMs: number
  private readonly sockets = new Set<WebSocketLike>()
  private readonly pendingRemoteEvents = new Map<string, { clientId: string; eventId: string; kind: 'approval' | 'question' }>()
  private authCookie: string | undefined
  private authBootstrap: Promise<void> | undefined

  constructor(options: DeepSeekHarnessAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.hostId = options.hostId
    this.authUrl = options.authUrl
    this.authUrlFile = options.authUrlFile
    this.authCookieFile = options.authCookieFile
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.WebSocketImpl = options.WebSocket ?? DefaultWebSocket
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  async hostDescribe(): Promise<HostDescriptor> {
    const value = await this.call<{
      items: Array<{
        cwd?: string
        projections?: { values: Record<string, unknown> }
      }>
    }>('session.list', {})

    const first = value.items[0]
    const selection = first?.projections?.values.modelSelection
    const current = isRecord(selection) && isRecord(selection.lastUsed) ? selection.lastUsed : undefined

    return {
      hostId: this.hostId,
      version: process.env.DSH_REMOTE_HARNESS_VERSION ?? 'current',
      cwd: first?.cwd ?? process.cwd(),
      ...(typeof current?.provider === 'string' && { provider: current.provider }),
      ...(typeof current?.model === 'string' && { model: current.model }),
      attachedSessions: value.items.length,
      principalUserId: '',
      principalDeviceId: '',
    }
  }

  async workspaceList(): Promise<WorkspaceListResult> {
    const value = await this.firstRemoteStreamValue('workspace/follow', {}) as {
      type?: string
      value?: {
        items: Array<{
          workspaceId: string
          path: string
          title: string
          sessionIds: string[]
          createdAt: string
          updatedAt: string
        }>
        archivedSessionIds: string[]
      }
    }
    if (value.type !== 'baseline' || value.value === undefined) {
      throw new HarnessAdapterError('unexpected workspace/follow opening frame', 'protocol')
    }

    return {
      items: value.value.items.map(workspace => ({
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        title: workspace.title,
        sessionIds: workspace.sessionIds,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })),
      archivedSessionIds: value.value.archivedSessionIds,
    }
  }

  async workspaceCreate(input: WorkspaceCreateInput): Promise<{ workspace: WorkspaceSummary; created: boolean }> {
    const value = await this.call<{
      workspace: {
        workspaceId: string
        path: string
        title: string
        sessionIds: string[]
        createdAt: string
        updatedAt: string
      }
      created: boolean
    }>('workspace.create', input)

    return {
      created: value.created,
      workspace: {
        workspaceId: value.workspace.workspaceId,
        path: value.workspace.path,
        title: value.workspace.title,
        sessionIds: value.workspace.sessionIds,
        createdAt: value.workspace.createdAt,
        updatedAt: value.workspace.updatedAt,
      },
    }
  }

  async sessionList(): Promise<SessionSummary[]> {
    const [sessions, workspaces] = await Promise.all([
      this.call<{
        items: Array<{
          sessionId: string
          updatedAt: number
          running: boolean
          blank: boolean
          cwd?: string
          origin?: 'subagent'
          projections?: {
            asOfSeq: number
            values: Record<string, unknown>
          }
        }>
      }>('session.list', {}),
      this.workspaceList(),
    ])

    const workspaceBySession = new Map<string, string>()
    for (const workspace of workspaces.items) {
      for (const sessionId of workspace.sessionIds) workspaceBySession.set(sessionId, workspace.workspaceId)
    }

    return sessions.items.map(item => {
      const title = item.projections?.values.title
      const agentPreset = item.projections?.values.agentPreset
      const workspaceId = workspaceBySession.get(item.sessionId)
      return {
        sessionId: item.sessionId,
        updatedAt: item.updatedAt,
        running: item.running,
        blank: item.blank,
        lastSeq: item.projections?.asOfSeq ?? -1,
        ...(workspaceId !== undefined && { workspaceId }),
        ...(typeof title === 'string' && { title }),
        ...(item.cwd !== undefined && { cwd: item.cwd }),
        ...(typeof agentPreset === 'string' && { agentPreset }),
        ...(item.origin !== undefined && { origin: item.origin }),
      }
    })
  }

  async sessionSearch(query: string): Promise<{ items: Array<{ sessionId: string; snippet: string }>; hasMore: boolean }> {
    const value = await this.call<{
      items: Array<{ sessionId: string; snippet: string }>
      hasMore: boolean
    }>('session.search', { query })
    return {
      items: value.items.map(item => ({ sessionId: item.sessionId, snippet: item.snippet })),
      hasMore: value.hasMore,
    }
  }

  async sessionCreate(input: SessionCreateInput): Promise<string> {
    const value = await this.call<{ sessionId: string }>('session.create', {
      ...(input.workspaceId !== undefined && { workspaceId: input.workspaceId }),
      ...(input.cwd !== undefined && { cwd: input.cwd }),
      ...(input.agentPreset !== undefined && { agentPreset: input.agentPreset }),
    })
    return value.sessionId
  }

  async agentPresetList(): Promise<AgentPresetOption[]> {
    const value = await this.call<{
      presets: Array<{
        id: string
        trust: 'system' | 'user'
        isDefault: boolean
        name?: string
        description?: string
        broken?: string
      }>
    }>('agentPreset.list', {})
    return value.presets.map(preset => ({
      id: preset.id,
      trust: preset.trust,
      isDefault: preset.isDefault,
      ...(preset.name !== undefined && { name: preset.name }),
      ...(preset.description !== undefined && { description: preset.description }),
      ...(preset.broken !== undefined && { broken: preset.broken }),
    }))
  }

  async agentPresetSelect(input: AgentPresetSelectInput): Promise<{ agentPreset: string }> {
    return this.call('agentPreset.select', input)
  }

  async sessionModels(sessionId: string): Promise<SessionModels> {
    void sessionId
    const value = await this.call<{
      default: SessionModels['current']
      routableProviders: string[]
      groups: SessionModels['groups']
      failures: SessionModels['failures']
    }>('session.models', {})
    return {
      current: {
        provider: value.default.provider,
        model: value.default.model,
        ...(value.default.reasoningEffort !== undefined && { reasoningEffort: value.default.reasoningEffort }),
      },
      routable: value.routableProviders.length > 0,
      groups: value.groups.map(group => ({
        id: group.id,
        name: group.name,
        models: group.models.map(model => ({
          id: model.id,
          name: model.name,
          ...(model.description !== undefined && { description: model.description }),
          ...(model.reasoning !== undefined && {
            reasoning: {
              efforts: model.reasoning.efforts.map(effort => ({
                id: effort.id,
                name: effort.name,
                ...(effort.description !== undefined && { description: effort.description }),
              })),
              ...(model.reasoning.defaultEffort !== undefined && { defaultEffort: model.reasoning.defaultEffort }),
            },
          }),
        })),
      })),
      failures: value.failures.map(failure => ({ ...failure })),
    }
  }

  async sessionSelectModel(input: SessionModelSelectInput): Promise<{ selected: SessionModels['current'] }> {
    return this.call('session.selectModel', {
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      ...(input.reasoningEffort !== undefined && { reasoningEffort: input.reasoningEffort }),
    })
  }

  async sessionHistory(query: SessionHistoryQuery): Promise<SessionHistoryPage> {
    const { sessionId, ...page } = query
    const listed = await this.call<{
      items: Array<{
        sessionId: string
        projections?: { asOfSeq: number }
      }>
    }>('session.list', {})
    const throughSeq = listed.items.find(item => item.sessionId === sessionId)?.projections?.asOfSeq ?? -1
    const value = await this.call<{
      records: Array<{
        type: 'event'
        event: {
          type: string
          seq: number
          time: number
          data: unknown
        }
        view?: unknown
      }>
      hasMore: boolean
    }>('session.history', {
      sessionId,
      throughSeq,
      ...(page.beforeSeq !== undefined && { beforeSeq: page.beforeSeq }),
      ...(page.maxMessages !== undefined && { maxMessages: page.maxMessages }),
    })

    const events: SessionEventView[] = value.records.map(entry => ({
      eventId: this.eventId(sessionId, entry.event.seq),
      sessionId,
      sequence: entry.event.seq,
      type: entry.event.type,
      payload: entry.event.data,
      timestamp: new Date(entry.event.time).toISOString(),
      ...(entry.view !== undefined && { view: entry.view }),
    }))

    return { sessionId, events, hasMore: value.hasMore }
  }

  async sessionPrompt(input: PromptInput): Promise<void> {
    await this.call<{ accepted: true }>('session.prompt', {
      sessionId: input.sessionId,
      mode: input.mode,
      content: [{ type: 'text', text: input.text }],
      clientTimeZone: 'Asia/Shanghai',
    })
  }

  async approvalRespond(rpcId: string, decision: ApprovalDecision): Promise<{ accepted: boolean }> {
    const value = await this.respond(rpcId, decision.outcome)
    return { accepted: value.accepted }
  }

  async questionRespond(rpcId: string, decision: QuestionDecision): Promise<{ accepted: boolean }> {
    const value = await this.respond(rpcId, decision.answer)
    return { accepted: value.accepted }
  }

  /** Yields normalized mux server-requests until the upstream streams close. */
  async *muxEvents(signal?: AbortSignal): AsyncGenerator<HarnessServerRequest> {
    yield * this.normalizedEvents(signal, true)
  }

  /** Yields normalized host notifications until the upstream stream closes. */
  async *hostEvents(signal?: AbortSignal): AsyncGenerator<HarnessServerRequest> {
    yield * this.currentEventFrames(signal)
  }

  close(): void {
    for (const socket of this.sockets) socket.close()
    this.sockets.clear()
  }

  private eventId(sessionId: string, sequence: number): EventId {
    return `${this.hostId}:${sessionId}:${sequence}` as EventId
  }

  private async call<T>(method: string, payload: unknown): Promise<T> {
    const result = await this.callRaw<T>(method, payload)
    if (!result.ok) {
      throw new HarnessAdapterError(
        `upstream RPC ${method} failed: ${result.error.message}`,
        'rpc',
      )
    }
    return result.value
  }

  private async callRaw<T>(method: string, payload: unknown): Promise<HarnessRpcResult<T>> {
    const upstream = this.resolveUpstreamRequest(method, payload)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`upstream RPC ${method} timed out`)), this.timeoutMs)
    try {
      const response = await this.fetchWithAuth(`${this.baseUrl}/api/${upstream.endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: this.newId(),
          method: upstream.endpoint,
          payload: { args: upstream.args },
        } satisfies HarnessClientRequest),
        signal: controller.signal,
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new HarnessAdapterError(
          `upstream HTTP ${response.status} for ${upstream.endpoint}: ${body.slice(0, 200)}`,
          'http',
          response.status,
        )
      }

      const body = (await response.json()) as HarnessServerResponse<T>
      if (body.type !== 'server-response') {
        throw new HarnessAdapterError(`unexpected upstream response for ${upstream.endpoint}`, 'protocol')
      }
      return body.result
    } finally {
      clearTimeout(timer)
    }
  }

  private async respond(rpcId: string, value: unknown): Promise<{ accepted: boolean }> {
    const pending = this.pendingRemoteEvents.get(rpcId)
    if (pending === undefined) return { accepted: false }

    const result = await this.callRaw<void>('$events/result', {
      clientId: pending.clientId,
      eventId: pending.eventId,
      outcome: { kind: 'result', value },
    })
    if (!result.ok) {
      throw new HarnessAdapterError(
        `upstream RPC $events/result failed: ${result.error.message}`,
        'rpc',
      )
    }
    this.pendingRemoteEvents.delete(rpcId)
    return { accepted: true }
  }

  private resolveUpstreamRequest(method: string, payload: unknown): { endpoint: string; args: Record<string, unknown> } {
    const value = isRecord(payload) ? payload : {}
    switch (method) {
      case '$events/result':
        return { endpoint: '$events/result', args: value }
      case 'workspace.create':
        return { endpoint: 'workspace/create', args: { request: value } }
      case 'session.list':
        return { endpoint: 'session/list', args: { _request: {} } }
      case 'session.search':
        return { endpoint: 'session/search', args: { request: value } }
      case 'session.create':
        return { endpoint: 'session/create', args: { request: value } }
      case 'agentPreset.list':
      case 'agent-preset.list':
        return { endpoint: 'agentPresets/list', args: {} }
      case 'agentPreset.select':
      case 'agent-preset.select':
        return {
          endpoint: 'agentPresets/select',
          args: {
            agentId: typeof value.sessionId === 'string' ? value.sessionId : '',
            agentPreset: typeof value.agentPreset === 'string' ? value.agentPreset : '',
          },
        }
      case 'session.history': {
        const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
        const throughSeq = typeof value.throughSeq === 'number' ? value.throughSeq : -1
        return {
          endpoint: 'session/page',
          args: {
            request: {
              address: { kind: 'session', sessionId },
              throughSeq,
              ...(typeof value.beforeSeq === 'number' && { beforeSeq: value.beforeSeq }),
              ...(typeof value.maxMessages === 'number' && { maxMessages: value.maxMessages }),
            },
          },
        }
      }
      case 'session.models':
        return { endpoint: 'session/modelCatalog', args: {} }
      case 'session.selectModel':
      case 'session.select-model':
        return { endpoint: 'session/selectModel', args: { request: value } }
      case 'session.prompt':
        return {
          endpoint: 'session/prompt',
          args: {
            request: {
              requestId: this.newId(),
              sessionId: value.sessionId,
              mode: value.mode,
              content: value.content,
              clientTimeZone: value.clientTimeZone,
            },
          },
        }
      default:
        throw new HarnessAdapterError(`unsupported upstream RPC ${method}`, 'protocol')
    }
  }

  private async *normalizedEvents(signal: AbortSignal | undefined, includeControl: boolean): AsyncGenerator<HarnessServerRequest> {
    type SourceName = 'events' | 'control' | 'session'
    type SourceState = {
      name: SourceName
      iterator: AsyncGenerator<unknown>
      next: Promise<IteratorResult<unknown>>
    }

    const states: SourceState[] = []
    const followedSessionIds = new Set<string>()
    const addSource = (name: SourceName, stream: AsyncGenerator<unknown>): void => {
      const iterator = stream[Symbol.asyncIterator]()
      states.push({ name, iterator, next: iterator.next() })
    }
    const addSession = (sessionId: unknown): void => {
      if (typeof sessionId !== 'string' || sessionId === '' || followedSessionIds.has(sessionId)) return
      followedSessionIds.add(sessionId)
      addSource('session', this.currentSessionFrames(sessionId, signal))
    }

    addSource('events', this.currentEventFrames(signal))
    if (includeControl) addSource('control', this.currentControlFrames(signal))

    const listed = await this.call<{ items: Array<{ sessionId: string }> }>('session.list', {})
    for (const item of listed.items) addSession(item.sessionId)

    try {
      while (states.length > 0) {
        const { state, result } = await Promise.race(states.map(state => state.next.then(result => ({ state, result }))))
        if (result.done) {
          states.splice(states.indexOf(state), 1)
          continue
        }

        state.next = state.iterator.next()
        const value = result.value as HarnessServerRequest
        if (value.method === 'session/added') {
          const payload = isRecord(value.payload) ? value.payload : undefined
          addSession(payload?.sessionId)
        }
        yield value
      }
    } finally {
      await Promise.allSettled(states.map(state => state.iterator.return?.(undefined)))
    }
  }

  private async *currentEventFrames(signal?: AbortSignal): AsyncGenerator<HarnessServerRequest> {
    let clientId: string | undefined
    try {
      for await (const value of this.remoteStream('$events', {}, signal)) {
        const frame = isRecord(value) ? value : undefined
        if (frame === undefined || typeof frame.type !== 'string') continue
        if (frame.type === 'ready') {
          clientId = typeof frame.clientId === 'string' ? frame.clientId : undefined
          continue
        }

        if (frame.type === 'emit') {
          const event = typeof frame.event === 'string' ? frame.event : ''
          const args = Array.isArray(frame.args) ? frame.args : []
          const normalized = this.normalizeEmittedEvent(event, args)
          if (normalized !== undefined) yield normalized
          continue
        }

        if (frame.type === 'waterfall') {
          const event = typeof frame.event === 'string' ? frame.event : ''
          const eventId = typeof frame.eventId === 'string' ? frame.eventId : ''
          const agentId = typeof frame.agentId === 'string' ? frame.agentId : undefined
          const request = isRecord(frame.request) ? frame.request : {}
          if (eventId === '' || clientId === undefined) continue
          if (event === 'approval/request') {
            this.pendingRemoteEvents.set(eventId, { clientId, eventId, kind: 'approval' })
            yield {
              type: 'server-request',
              rpcId: eventId,
              method: 'approval/requested',
              payload: {
                type: 'approval/requested',
                ...(agentId !== undefined && { sessionId: agentId }),
                rpcId: eventId,
                approvalId: eventId,
                ...(typeof request.toolName === 'string' && { toolName: request.toolName }),
                ...(typeof request.callId === 'string' && { callId: request.callId }),
                ...(typeof request.reason === 'string' && { reason: request.reason }),
              },
            }
          } else if (event === 'user-questions/request') {
            this.pendingRemoteEvents.set(eventId, { clientId, eventId, kind: 'question' })
            yield {
              type: 'server-request',
              rpcId: eventId,
              method: 'question/requested',
              payload: {
                type: 'question/requested',
                ...(agentId !== undefined && { sessionId: agentId }),
                rpcId: eventId,
                questions: Array.isArray(request.questions) ? request.questions : [],
              },
            }
          }
          continue
        }

        if (frame.type === 'cancel') {
          const eventId = typeof frame.eventId === 'string' ? frame.eventId : ''
          const pending = this.pendingRemoteEvents.get(eventId)
          if (pending === undefined) continue
          this.pendingRemoteEvents.delete(eventId)
          yield {
            type: 'server-request',
            rpcId: eventId,
            method: pending.kind === 'approval' ? 'approval/resolved' : 'question/resolved',
            payload: {
              type: pending.kind === 'approval' ? 'approval/resolved' : 'question/resolved',
              rpcId: eventId,
              ...(pending.kind === 'approval' && { approvalId: eventId, outcome: 'cancelled' }),
            },
          }
        }
      }
    } finally {
      if (clientId !== undefined) {
        for (const [rpcId, pending] of this.pendingRemoteEvents) {
          if (pending.clientId === clientId) this.pendingRemoteEvents.delete(rpcId)
        }
      }
    }
  }

  private normalizeEmittedEvent(event: string, args: unknown[]): HarnessServerRequest | undefined {
    if (event === 'api-session/activity') {
      return this.sessionNotification('session/activity', args[0], { updatedAt: args[1] })
    }
    if (event === 'api-session/status') {
      return this.sessionNotification('session/status', args[0], { running: args[1] })
    }
    if (event === 'api-session/error') {
      return this.sessionNotification('session/error', args[0], { message: args[1] })
    }
    if (event === 'api-session/removed') {
      return this.sessionNotification('session/removed', args[0], {})
    }
    if (event === 'api-session/added') {
      const summary = isRecord(args[0]) ? args[0] : {}
      const sessionId = typeof summary.sessionId === 'string' ? summary.sessionId : undefined
      return {
        type: 'server-request',
        rpcId: `event:${event}:${sessionId ?? this.newId()}`,
        method: 'session/added',
        payload: { type: 'session/added', ...summary },
      }
    }
    if (event === 'agent-preset/selected') {
      return this.sessionNotification('agent-preset/selected', args[0], { agentPreset: args[1] })
    }
    return {
      type: 'server-request',
      rpcId: `event:${event}:${this.newId()}`,
      method: event,
      payload: { type: event, args },
    }
  }

  private sessionNotification(type: string, sessionIdValue: unknown, extra: Record<string, unknown>): HarnessServerRequest | undefined {
    if (typeof sessionIdValue !== 'string' || sessionIdValue === '') return undefined
    return {
      type: 'server-request',
      rpcId: `event:${type}:${sessionIdValue}:${this.newId()}`,
      method: type,
      payload: { type, sessionId: sessionIdValue, ...extra },
    }
  }

  private async *currentControlFrames(signal?: AbortSignal): AsyncGenerator<HarnessServerRequest> {
    for await (const value of this.remoteStream('session/control', {}, signal)) {
      const frame = isRecord(value) ? value : undefined
      if (frame === undefined || typeof frame.type !== 'string') continue
      if (frame.type === 'baseline') {
        const baselineValue = frame.value
        const baseline = isRecord(baselineValue) ? baselineValue : undefined
        const queueValue = baseline?.queues
        const queues = isRecord(queueValue) ? queueValue : {}
        for (const [sessionId, items] of Object.entries(queues)) {
          yield this.queueNotification(sessionId, items)
        }
      } else if (frame.type === 'queue' && typeof frame.sessionId === 'string') {
        yield this.queueNotification(frame.sessionId, frame.items)
      }
    }
  }

  private async *currentSessionFrames(sessionId: string, signal?: AbortSignal): AsyncGenerator<HarnessServerRequest> {
    for await (const value of this.remoteStream('session/follow', {
      request: {
        address: { kind: 'session', sessionId },
        maxMessages: 50,
        assistantStream: true,
      },
    }, signal)) {
      const frame = isRecord(value) ? value : undefined
      if (frame === undefined || typeof frame.type !== 'string' || frame.type !== 'event') continue
      const event = isRecord(frame.event) ? frame.event : undefined
      if (event === undefined || typeof event.type !== 'string' || typeof event.seq !== 'number' || typeof event.time !== 'number') continue
      yield {
        type: 'server-request',
        rpcId: `session-event:${sessionId}:${event.seq}`,
        method: 'session/event',
        payload: {
          type: 'session/event',
          sessionId,
          event: {
            type: event.type,
            seq: event.seq,
            time: event.time,
            data: event.data,
          },
          ...(frame.view !== undefined && { view: frame.view }),
        },
      }
    }
  }

  private queueNotification(sessionId: string, items: unknown): HarnessServerRequest {
    return {
      type: 'server-request',
      rpcId: `queue:${sessionId}:${this.newId()}`,
      method: 'session/queue',
      payload: { type: 'session/queue', sessionId, items: Array.isArray(items) ? items : [] },
    }
  }

  private async firstRemoteStreamValue(endpoint: string, args: Record<string, unknown>): Promise<unknown> {
    for await (const value of this.remoteStream(endpoint, args)) return value
    throw new HarnessAdapterError(`upstream stream ${endpoint} ended before its opening frame`, 'protocol')
  }

  private async *remoteStream(endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<unknown> {
    const url = new URL('/api/remote.mux', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

    const cookie = await this.ensureAuthCookie()
    const socket = new this.WebSocketImpl(
      url.toString(),
      cookie === undefined ? undefined : { headers: { cookie } },
    )
    this.sockets.add(socket)

    const values: unknown[] = []
    let wake: (() => void) | undefined
    let opened = false
    let ended = false
    let closed = false
    let failure: HarnessAdapterError | undefined
    const streamId = this.newId()
    let resolveOpen: (() => void) | undefined
    let rejectOpen: ((error: HarnessAdapterError) => void) | undefined
    let openSettled = false
    const openPromise = new Promise<void>((resolve, reject) => {
      resolveOpen = resolve
      rejectOpen = reject
    })
    const openTimer = setTimeout(() => {
      if (!openSettled) {
        openSettled = true
        rejectOpen?.(new HarnessAdapterError(`WebSocket /api/remote.mux open timed out`, 'protocol'))
      }
    }, this.timeoutMs)

    const wakeReader = () => {
      wake?.()
      wake = undefined
    }
    socket.addEventListener('open', () => {
      opened = true
      try {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: payload } }))
      } catch (cause) {
        failure = new HarnessAdapterError(
          `WebSocket /api/remote.mux failed to send its opening frame: ${String(cause)}`,
          'protocol',
        )
        closed = true
      }
      if (!openSettled) {
        openSettled = true
        clearTimeout(openTimer)
        if (failure === undefined) resolveOpen?.()
        else rejectOpen?.(failure)
      }
      wakeReader()
    })
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data ?? '')) as Record<string, unknown>
        if (message.streamId !== streamId) return
        if (message.type === 'item') {
          values.push(message.value)
        } else if (message.type === 'end') {
          ended = true
          closed = true
        } else if (message.type === 'error') {
          const error = isRecord(message.error) ? message.error : {}
          failure = new HarnessAdapterError(
            typeof error.message === 'string' ? error.message : `upstream stream ${endpoint} failed`,
            'rpc',
          )
          closed = true
        }
        wakeReader()
      } catch {
        failure = new HarnessAdapterError(`invalid upstream stream frame for ${endpoint}`, 'protocol')
        closed = true
        wakeReader()
      }
    })
    socket.addEventListener('close', () => {
      closed = true
      if (!opened && !openSettled) {
        openSettled = true
        clearTimeout(openTimer)
        rejectOpen?.(new HarnessAdapterError(`WebSocket /api/remote.mux failed to open`, 'protocol'))
      }
      wakeReader()
    })
    socket.addEventListener('error', () => {
      if (!opened) {
        failure = new HarnessAdapterError(`WebSocket /api/remote.mux failed to open`, 'protocol')
        if (!openSettled) {
          openSettled = true
          clearTimeout(openTimer)
          rejectOpen?.(failure)
        }
      }
      closed = true
      wakeReader()
    })

    const onAbort = () => {
      if (opened && !ended) {
        try {
          socket.send(JSON.stringify({ type: 'cancel', streamId }))
        } catch {
          // The socket may already have closed; cleanup below is sufficient.
        }
      }
      closed = true
      if (!openSettled) {
        openSettled = true
        clearTimeout(openTimer)
        rejectOpen?.(new HarnessAdapterError(`WebSocket /api/remote.mux aborted before opening`, 'protocol'))
      }
      socket.close()
      wakeReader()
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await openPromise

      while (true) {
        if (values.length > 0) {
          yield values.shift()
        } else if (failure !== undefined) {
          throw failure
        } else if (closed) {
          if (!signal?.aborted && !ended) throw new HarnessAdapterError(`upstream stream ${endpoint} closed`, 'protocol')
          return
        } else {
          await new Promise<void>(resolve => { wake = resolve })
        }
      }
    } catch (cause) {
      if (!signal?.aborted) throw cause
    } finally {
      signal?.removeEventListener('abort', onAbort)
      socket.close()
      this.sockets.delete(socket)
    }
  }

  private async *websocketEvents(path: string, signal?: AbortSignal): AsyncGenerator<HarnessServerRequest> {
    void path
    yield * this.currentEventFrames(signal)
  }

  /*
   * Kept as a compatibility shim for callers built against the previous
   * adapter surface. New code uses `remoteStream` and the current Gateway
   * mux protocol above.
   */
  private async *legacyWebsocketEvents(path: string, signal?: AbortSignal): AsyncGenerator<HarnessServerRequest> {
    const url = new URL(path, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

    const cookie = await this.ensureAuthCookie()
    const socket = new this.WebSocketImpl(
      url.toString(),
      cookie === undefined ? undefined : { headers: { cookie } },
    )
    this.sockets.add(socket)

    const messages: HarnessServerRequest[] = []
    let wake: (() => void) | undefined
    let closed = false

    const closeListener = () => {
      closed = true
      wake?.()
    }

    socket.addEventListener('open', () => wake?.())
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data ?? '')) as { type?: string }
        if (message.type === 'server-request') {
          messages.push(message as HarnessServerRequest)
          wake?.()
        }
      } catch {
        // Ignore malformed upstream frames; the remote layer treats socket
        // liveness and session.history recovery as the fallback.
      }
    })
    socket.addEventListener('close', closeListener)
    socket.addEventListener('error', closeListener)

    const onAbort = () => {
      closed = true
      socket.close()
      wake?.()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new HarnessAdapterError(`WebSocket ${path} open timed out`, 'protocol')), this.timeoutMs)
        socket.addEventListener('open', () => {
          clearTimeout(timer)
          resolve()
        })
        socket.addEventListener('error', () => {
          clearTimeout(timer)
          reject(new HarnessAdapterError(`WebSocket ${path} failed to open`, 'protocol'))
        })
      })

      while (true) {
        if (messages.length > 0) {
          yield messages.shift()!
        } else if (closed) {
          return
        } else {
          await new Promise<void>(resolve => {
            wake = resolve
          })
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      socket.close()
      this.sockets.delete(socket)
    }
  }

  private hasAuthSource(): boolean {
    return this.authUrl !== undefined || this.authUrlFile !== undefined || this.authCookieFile !== undefined
  }

  private async fetchWithAuth(input: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cookie = await this.ensureAuthCookie()
      const headers = new Headers(init.headers)
      if (cookie !== undefined) headers.set('cookie', cookie)
      const response = await this.fetchImpl(input, { ...init, headers })
      if (response.status !== 401 || !this.hasAuthSource() || attempt === 1) return response
      this.authCookie = undefined
      await this.removeCachedCookie()
    }
    throw new Error('unreachable')
  }

  private async ensureAuthCookie(): Promise<string | undefined> {
    if (this.authCookie !== undefined) return this.authCookie
    if (this.authBootstrap !== undefined) {
      await this.authBootstrap
      return this.authCookie
    }

    this.authBootstrap = this.bootstrapAuth().finally(() => {
      this.authBootstrap = undefined
    })
    await this.authBootstrap
    return this.authCookie
  }

  private async bootstrapAuth(): Promise<void> {
    if (this.authCookieFile !== undefined) {
      try {
        const cached = (await readFile(this.authCookieFile, 'utf8')).trim()
        if (cached !== '') {
          this.authCookie = cached.split(';', 1)[0]
          return
        }
      } catch {
        // The cache is optional; fall through to the launch URL exchange.
      }
    }

    const authUrl = await this.resolveAuthUrl()
    if (authUrl === undefined) return

    const response = await this.fetchImpl(authUrl, {
      method: 'GET',
      redirect: 'manual',
    })
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const setCookie = headers.getSetCookie?.()[0] ?? headers.get('set-cookie')
    if (setCookie === null || setCookie === undefined || setCookie === '') {
      throw new HarnessAdapterError(
        `Harness browser authentication did not issue a session cookie (HTTP ${response.status})`,
        'http',
        response.status,
      )
    }

    this.authCookie = setCookie.split(';', 1)[0]
    if (this.authCookieFile !== undefined) {
      await mkdir(dirname(this.authCookieFile), { recursive: true })
      await writeFile(this.authCookieFile, `${this.authCookie}\n`, { mode: 0o600 })
    }
  }

  private async resolveAuthUrl(): Promise<string | undefined> {
    if (this.authUrl !== undefined && this.authUrl.trim() !== '') return this.authUrl.trim()
    if (this.authUrlFile === undefined) return undefined

    try {
      const contents = await readFile(this.authUrlFile, 'utf8')
      const line = contents.split(/\r?\n/u).map(value => value.trim()).find(value => value !== '')
      if (line === undefined) return undefined
      const match = /^dsh web:\s+(\S+)$/u.exec(line)
      return match?.[1] ?? line
    } catch {
      return undefined
    }
  }

  private async removeCachedCookie(): Promise<void> {
    if (this.authCookieFile !== undefined) {
      await rm(this.authCookieFile, { force: true }).catch(() => undefined)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
