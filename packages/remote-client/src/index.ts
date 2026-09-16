import type {
  AgentPresetOption,
  AgentPresetSelectInput,
  ApprovalDecision,
  CheckDefinitionSummary,
  CheckRun,
  CheckRunInput,
  HostDescriptor,
  PreviewDefinitionSummary,
  PreviewOpenInput,
  PreviewOpenResult,
  PushSubscriptionInput,
  PushSubscriptionSummary,
  PushUnsubscribeInput,
  PushVapidResult,
  PromptInput,
  QuestionDecision,
  RemoteApiMap,
  RemoteMethod,
  SessionCreateInput,
  SessionHistoryPage,
  SessionHistoryQuery,
  SessionModels,
  SessionModelSelectInput,
  SessionSearchItem,
  SessionSummary,
  WorkspaceCreateInput,
  WorkspaceListResult,
  WorkspaceSummary,
} from '@dsh-remote/domain'
import {
  PROTOCOL_VERSION,
  isRemoteEventEnvelope,
  isRemoteRpcResponse,
  newRequestId,
  type RemoteEventEnvelope,
  type RemoteHostHealth,
  type RemoteRpcRequest,
  type RemoteRpcResponse,
} from '@dsh-remote/protocol'

export * from './sequence-tracker.js'

export interface WebSocketLike {
  readonly readyState: number
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: WebSocketEventLike) => void): void
  close(): void
}

export interface WebSocketEventLike {
  type: string
  data?: unknown
}

export type WebSocketConstructor = new (url: string) => WebSocketLike

export interface AgentHostTransport {
  readonly baseUrl: string
  health(): Promise<RemoteHostHealth>
  hostDescribe(): Promise<HostDescriptor>
  listWorkspaces(): Promise<WorkspaceListResult>
  createWorkspace(input: WorkspaceCreateInput): Promise<{ workspace: WorkspaceSummary; created: boolean }>
  listSessions(): Promise<{ items: SessionSummary[] }>
  searchSessions(query: string): Promise<{ items: SessionSearchItem[]; hasMore: boolean }>
  createSession(input: SessionCreateInput, idempotencyKey?: string): Promise<string>
  listAgentPresets(): Promise<{ items: AgentPresetOption[] }>
  selectAgentPreset(input: AgentPresetSelectInput, idempotencyKey?: string): Promise<{ agentPreset: string }>
  sessionHistory(query: SessionHistoryQuery): Promise<SessionHistoryPage>
  sessionModels(sessionId: string): Promise<SessionModels>
  selectSessionModel(input: SessionModelSelectInput, idempotencyKey?: string): Promise<SessionModels['current']>
  prompt(input: PromptInput, idempotencyKey?: string): Promise<void>
  approvalRespond(decision: ApprovalDecision): Promise<{ accepted: boolean }>
  questionRespond(decision: QuestionDecision): Promise<{ accepted: boolean }>
  listChecks(): Promise<{ items: CheckDefinitionSummary[] }>
  runCheck(input: CheckRunInput, idempotencyKey?: string): Promise<CheckRun>
  getCheck(runId: string): Promise<CheckRun>
  cancelCheck(runId: string, idempotencyKey?: string): Promise<{ accepted: boolean }>
  listPreviews(): Promise<{ items: PreviewDefinitionSummary[] }>
  openPreview(input: PreviewOpenInput): Promise<PreviewOpenResult>
  pushVapid(): Promise<PushVapidResult>
  listPushSubscriptions(): Promise<{ items: PushSubscriptionSummary[] }>
  subscribePush(input: PushSubscriptionInput): Promise<{ subscriptionId: string }>
  unsubscribePush(input: PushUnsubscribeInput): Promise<{ accepted: boolean }>
  /**
   * `onOpen` fires once the stream handshake completes, before any frame is
   * yielded. Callers need it because an idle host sends nothing: without it,
   * "the stream is up" is indistinguishable from "still dialling".
   */
  events(kind?: 'mux' | 'host', signal?: AbortSignal, onOpen?: () => void): AsyncGenerator<RemoteEventEnvelope>
  close(): void
}

export interface DirectTailnetTransportOptions {
  baseUrl: string
  fetch?: typeof fetch
  WebSocket?: WebSocketConstructor
  timeoutMs?: number
  /**
   * Deadline for opening the event WebSocket, separate from `timeoutMs`
   * because it answers a different question. An RPC deadline must tolerate a
   * slow reply from a busy Harness, while the stream handshake only asks
   * whether the host is reachable at all — and a client that reconnects on a
   * budget pays this timeout once per attempt. Defaults to `timeoutMs`.
   */
  eventOpenTimeoutMs?: number
}

export class RemoteTransportError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'protocol' | 'rpc',
    readonly status?: number,
  ) {
    super(message)
    this.name = 'RemoteTransportError'
  }
}

/**
 * A-transport: talks to the loopback Remote Host Adapter through Tailscale
 * Serve. B will implement the same AgentHostTransport over the Relay.
 */
export class DirectTailnetTransport implements AgentHostTransport {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly WebSocketImpl: WebSocketConstructor
  private readonly timeoutMs: number
  private readonly eventOpenTimeoutMs: number
  private readonly sockets = new Set<WebSocketLike>()

  constructor(options: DirectTailnetTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.WebSocketImpl = options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketConstructor)
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.eventOpenTimeoutMs = options.eventOpenTimeoutMs ?? this.timeoutMs
  }

  async health(): Promise<RemoteHostHealth> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/health`)
    if (!response.ok) throw new RemoteTransportError(`health HTTP ${response.status}`, 'http', response.status)
    return response.json() as Promise<RemoteHostHealth>
  }

  hostDescribe(): Promise<HostDescriptor> {
    return this.rpc('host.describe', {})
  }

  listWorkspaces(): Promise<WorkspaceListResult> {
    return this.rpc('workspace.list', {})
  }

  createWorkspace(input: WorkspaceCreateInput): Promise<{ workspace: WorkspaceSummary; created: boolean }> {
    return this.rpc('workspace.create', input)
  }

  listSessions(): Promise<{ items: SessionSummary[] }> {
    return this.rpc('session.list', {})
  }

  searchSessions(query: string): Promise<{ items: SessionSearchItem[]; hasMore: boolean }> {
    return this.rpc('session.search', { query })
  }

  async createSession(input: SessionCreateInput, idempotencyKey?: string): Promise<string> {
    const value = await this.rpc('session.create', input, idempotencyKey)
    return value.sessionId
  }

  listAgentPresets(): Promise<{ items: AgentPresetOption[] }> {
    return this.rpc('agent-preset.list', {})
  }

  selectAgentPreset(input: AgentPresetSelectInput, idempotencyKey?: string): Promise<{ agentPreset: string }> {
    return this.rpc('agent-preset.select', input, idempotencyKey)
  }

  sessionHistory(query: SessionHistoryQuery): Promise<SessionHistoryPage> {
    return this.rpc('session.history', query)
  }

  sessionModels(sessionId: string): Promise<SessionModels> {
    return this.rpc('session.models', { sessionId })
  }

  async selectSessionModel(input: SessionModelSelectInput, idempotencyKey?: string): Promise<SessionModels['current']> {
    const value = await this.rpc('session.select-model', input, idempotencyKey)
    return value.selected
  }

  async prompt(input: PromptInput, idempotencyKey?: string): Promise<void> {
    await this.rpc('session.prompt', input, idempotencyKey)
  }

  async approvalRespond(decision: ApprovalDecision): Promise<{ accepted: boolean }> {
    return this.rpc(
      'approval.respond',
      decision,
      `approval:${decision.sessionId}:${decision.approvalId}:${decision.rpcId}:${decision.outcome}`,
    )
  }

  async questionRespond(decision: QuestionDecision): Promise<{ accepted: boolean }> {
    return this.rpc(
      'question.respond',
      decision,
      `question:${decision.sessionId}:${decision.rpcId}`,
    )
  }

  listChecks(): Promise<{ items: CheckDefinitionSummary[] }> {
    return this.rpc('check.list', {})
  }

  runCheck(input: CheckRunInput, idempotencyKey?: string): Promise<CheckRun> {
    return this.rpc('check.run', input, idempotencyKey)
  }

  getCheck(runId: string): Promise<CheckRun> {
    return this.rpc('check.get', { runId })
  }

  cancelCheck(runId: string, idempotencyKey?: string): Promise<{ accepted: boolean }> {
    return this.rpc('check.cancel', { runId }, idempotencyKey)
  }

  listPreviews(): Promise<{ items: PreviewDefinitionSummary[] }> {
    return this.rpc('preview.list', {})
  }

  openPreview(input: PreviewOpenInput): Promise<PreviewOpenResult> {
    return this.rpc('preview.open', input)
  }

  pushVapid(): Promise<PushVapidResult> {
    return this.rpc('push.vapid', {})
  }

  listPushSubscriptions(): Promise<{ items: PushSubscriptionSummary[] }> {
    return this.rpc('push.list', {})
  }

  subscribePush(input: PushSubscriptionInput): Promise<{ subscriptionId: string }> {
    return this.rpc('push.subscribe', input)
  }

  unsubscribePush(input: PushUnsubscribeInput): Promise<{ accepted: boolean }> {
    return this.rpc('push.unsubscribe', input)
  }

  async *events(kind: 'mux' | 'host' = 'mux', signal?: AbortSignal, onOpen?: () => void): AsyncGenerator<RemoteEventEnvelope> {
    const path = kind === 'mux' ? '/api/remote/events.mux' : '/api/remote/events.host'
    const url = new URL(path, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

    const socket = new this.WebSocketImpl(url.toString())
    this.sockets.add(socket)

    const messages: RemoteEventEnvelope[] = []
    let wake: (() => void) | undefined
    let closed = false

    const closeListener = () => {
      closed = true
      wake?.()
    }
    socket.addEventListener('open', () => wake?.())
    socket.addEventListener('message', event => {
      try {
        const value = JSON.parse(String(event.data ?? '')) as unknown
        if (isRemoteEventEnvelope(value)) {
          messages.push(value)
          wake?.()
        }
      } catch {
        // Ignore malformed frames; the transport remains re-openable.
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
        const timer = setTimeout(() => reject(new RemoteTransportError(`WebSocket ${path} open timed out`, 'protocol')), this.eventOpenTimeoutMs)
        socket.addEventListener('open', () => {
          clearTimeout(timer)
          resolve()
        })
        socket.addEventListener('error', () => {
          clearTimeout(timer)
          reject(new RemoteTransportError(`WebSocket ${path} failed to open`, 'protocol'))
        })
      })

      onOpen?.()

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

  close(): void {
    for (const socket of this.sockets) socket.close()
    this.sockets.clear()
  }

  private async rpc<M extends RemoteMethod>(
    method: M,
    payload: RemoteApiMap[M]['payload'],
    idempotencyKey?: string,
  ): Promise<RemoteApiMap[M]['result']> {
    const request: RemoteRpcRequest = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: newRequestId(),
      method,
      payload,
      ...(idempotencyKey !== undefined && { idempotencyKey }),
    }
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/remote/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      throw new RemoteTransportError(`remote HTTP ${response.status} for ${method}`, 'http', response.status)
    }

    const body = (await response.json()) as unknown
    if (!isRemoteRpcResponse(body)) {
      throw new RemoteTransportError(`invalid remote response for ${method}`, 'protocol')
    }
    if (body.requestId !== request.requestId || body.method !== method) {
      throw new RemoteTransportError(`response correlation failed for ${method}`, 'protocol')
    }
    if (!body.result.ok) {
      throw new RemoteTransportError(`remote RPC ${method}: ${body.result.error.message}`, 'rpc')
    }
    return body.result.value as RemoteApiMap[M]['result']
  }

  private async fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('remote request timed out')), this.timeoutMs)
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}
