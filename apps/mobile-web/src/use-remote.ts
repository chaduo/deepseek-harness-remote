import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RemoteSequenceTracker, RemoteTransportError } from '@dsh-remote/client'
import { reusableBlankSession, visibleTaskSessions } from '@dsh-remote/domain'
import type {
  AgentPresetOption,
  ApprovalDecision,
  ApprovalRequest,
  HostDescriptor,
  QuestionAnswerItem,
  QuestionDecision,
  QuestionRequest,
  SessionEventView,
  SessionHistoryPage,
  SessionModels,
  SessionModelSelectInput,
  SessionSearchItem,
  SessionSummary,
  WorkspaceSummary,
} from '@dsh-remote/domain'
import type { RemoteEventEnvelope, RemoteEventStream, RemoteHostHealth } from '@dsh-remote/protocol'
import { feedbackFor } from './errors.js'
import type { UserFeedback } from './errors.js'
import {
  emptyQuestionAnswers,
  offlineProbeDelay,
  resolvedApproval,
  withResolvedApproval,
  withoutPendingApproval,
} from './remote-state.js'
import type { ApprovalDisplay, ResolvedApproval } from './remote-state.js'
import { transport } from './transport.js'

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'offline'

/**
 * Backoff between reconnect attempts. A Mac that is asleep, off the tailnet, or
 * running without the Harness will not come back on its own, so retrying
 * forever only drains the phone battery while looking indistinguishable from a
 * live link. Once the budget below is spent the connection goes 'offline' and
 * low-frequency health probes take over until the user or host brings it back.
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 8_000]

/**
 * The budget is wall-clock, not a number of attempts. Counting attempts makes
 * the real wait depend on how long each one takes to fail, so a handshake that
 * hangs turns "fifteen seconds of backoff" into minutes of 正在连接 that the
 * numbers give no way to predict. A deadline holds however the failures
 * arrive. It starts at the first failure, so the attempt that was in flight
 * when the link dropped does not count against it, and the final attempt may
 * overrun it by up to one handshake timeout.
 */
const RECONNECT_BUDGET_MS = 30_000

export type CreateWorkspaceResult = { ok: true } | { ok: false; reason: string }

/**
 * Nothing in the protocol heartbeats, and a tailnet that drops out from under
 * an open WebSocket produces no close and no error: the socket simply stops
 * delivering, so the reader would wait on it forever while the UI claimed the
 * Mac was online. Probe the host whenever the stream has been quiet this long,
 * and treat a failed probe as a dead link.
 */
const STREAM_IDLE_PROBE_MS = 20_000
const PROBE_TIMEOUT_MS = 10_000

const LAST_CONNECTED_STORAGE_KEY = 'dsh-remote:last-connected-at'

/**
 * Distinguishes 'the Mac answered and said no' from 'nothing came back'. Only
 * the latter says anything about the link: an RPC rejection or an HTTP status
 * both prove the host is reachable.
 */
function isLinkFailure(cause: unknown): boolean {
  if (cause instanceof RemoteTransportError) return cause.kind === 'protocol'
  return true
}

async function probeHost(): Promise<boolean> {
  try {
    await Promise.race([
      transport.health(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS)
      }),
    ])
    return true
  } catch (cause) {
    // An HTTP status is still an answer: the host is reachable, it only said
    // no. Silence is the single signal that the link itself is gone.
    return !isLinkFailure(cause)
  }
}

function storedLastConnectedAt(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_CONNECTED_STORAGE_KEY)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

interface LiveSessionEvent {
  event: {
    type: string
    seq: number
    time: number
    data: unknown
  }
  view?: unknown
}

function asApprovalRequest(payload: unknown): ApprovalRequest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = payload as Record<string, unknown>
  if (
    typeof value.sessionId === 'string'
    && typeof value.rpcId === 'string'
    && typeof value.approvalId === 'string'
    && typeof value.toolName === 'string'
  ) {
    return {
      sessionId: value.sessionId,
      rpcId: value.rpcId,
      approvalId: value.approvalId,
      toolName: value.toolName,
      ...(typeof value.callId === 'string' && { callId: value.callId }),
      ...(typeof value.reason === 'string' && { reason: value.reason }),
    }
  }
  return undefined
}

function asQuestionRequest(payload: unknown): QuestionRequest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = payload as Record<string, unknown>
  if (typeof value.sessionId === 'string' && typeof value.rpcId === 'string' && Array.isArray(value.questions)) {
    return {
      sessionId: value.sessionId,
      rpcId: value.rpcId,
      questions: value.questions as QuestionRequest['questions'],
    }
  }
  return undefined
}

export interface RemoteQueuedItem {
  id: string
  placement: 'queued' | 'steering' | 'context'
  text: string
}

function asQueuedItems(payload: unknown): RemoteQueuedItem[] {
  if (typeof payload !== 'object' || payload === null) return []
  const value = payload as Record<string, unknown>
  if (Array.isArray(value.items) === false) return []
  const items: RemoteQueuedItem[] = []
  for (const entry of value.items) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : ''
    const placement = item.placement === 'steering' || item.placement === 'context' ? item.placement : 'queued'
    const message = item.message as Record<string, unknown> | undefined
    const content = Array.isArray(message?.content) ? message.content : []
    const text = content
      .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
      .map(block => typeof block.text === 'string' ? block.text : '')
      .join(' ')
      .trim()
    if (id === '' || text === '') continue
    items.push({ id, placement, text })
  }
  return items
}

function asLiveSessionEvent(payload: unknown): LiveSessionEvent | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = payload as Record<string, unknown>
  if (typeof value.event !== 'object' || value.event === null) return undefined
  const event = value.event as Record<string, unknown>
  if (typeof event.type === 'string' && typeof event.seq === 'number' && typeof event.time === 'number') {
    return {
      event: {
        type: event.type,
        seq: event.seq,
        time: event.time,
        data: event.data,
      },
      ...(value.view !== undefined && { view: value.view }),
    }
  }
  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function toolTitleFor(request: ApprovalRequest, event: SessionEventView | undefined): string {
  const view = record(record(event?.view)?.view)
  const viewTitle = typeof view?.title === 'string' ? view.title : undefined
  if (viewTitle !== undefined && viewTitle.trim() !== '') return viewTitle
  const payload = record(event?.payload)
  const argumentsText = payload?.arguments
  if (typeof argumentsText === 'string') {
    try {
      const parsed = JSON.parse(argumentsText) as unknown
      const parsedRecord = record(parsed)
      const command = typeof parsedRecord?.command === 'string' ? parsedRecord.command : undefined
      if (command !== undefined && command.trim() !== '') return command
      const filePath = typeof parsedRecord?.file_path === 'string' ? parsedRecord.file_path : undefined
      if (filePath !== undefined) return `写文件 ${filePath}`
    } catch {
      return argumentsText
    }
  }
  return request.toolName
}

function argumentsTextFor(event: SessionEventView | undefined): string | undefined {
  const argumentsValue = record(event?.payload)?.arguments
  if (typeof argumentsValue === 'string') return argumentsValue
  if (argumentsValue !== undefined) return JSON.stringify(argumentsValue)
  return undefined
}

export function useRemote() {
  const trackerRef = useRef(new RemoteSequenceTracker())
  const rebaselineStreamsRef = useRef(new Set<RemoteEventStream>())
  const selectedSessionIdRef = useRef<string | null>(null)
  const [health, setHealth] = useState<RemoteHostHealth | null>(null)
  const [host, setHost] = useState<HostDescriptor | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [archivedSessionIds, setArchivedSessionIds] = useState<string[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [agentPresets, setAgentPresets] = useState<AgentPresetOption[]>([])
  const [sessionModels, setSessionModels] = useState<SessionModels | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [searchResults, setSearchResults] = useState<SessionSearchItem[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [history, setHistory] = useState<SessionHistoryPage | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [historyNotice, setHistoryNotice] = useState<UserFeedback | null>(null)
  const historyRef = useRef<SessionHistoryPage | null>(null)
  const historyGenerationRef = useRef(0)
  const loadingOlderRef = useRef(false)
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([])
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([])
  const [approvalDisplays, setApprovalDisplays] = useState<Record<string, ApprovalDisplay>>({})
  const [resolvedApprovals, setResolvedApprovals] = useState<ResolvedApproval[]>([])
  const [approvalNotice, setApprovalNotice] = useState<ResolvedApproval | null>(null)
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionAnswerItem[]>>({})
  const pendingApprovalsRef = useRef<ApprovalRequest[]>([])
  const approvalDisplaysRef = useRef<Record<string, ApprovalDisplay>>({})
  const resolvedApprovalIdsRef = useRef(new Set<string>())
  const [queuedBySession, setQueuedBySession] = useState<Record<string, RemoteQueuedItem[]>>({})
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const connectionRef = useRef<ConnectionState>('connecting')
  const lastEventAtRef = useRef(Date.now())
  const [reconnectNonce, setReconnectNonce] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const lastConnectedRef = useRef<number | null>(storedLastConnectedAt())
  const [lastConnectedAt, setLastConnectedAt] = useState<number | null>(lastConnectedRef.current)
  const [gapNotice, setGapNotice] = useState('')
  const [error, setError] = useState<UserFeedback | null>(null)

  /**
   * Remember when the link was last alive so the offline screen can say how
   * stale it is. Kept in storage because the phone may be reopened long after
   * the app was suspended.
   */
  useEffect(() => {
    if (connection !== 'open') {
      setLastConnectedAt(lastConnectedRef.current)
      return
    }
    const mark = () => {
      const now = Date.now()
      lastConnectedRef.current = now
      try {
        window.localStorage.setItem(LAST_CONNECTED_STORAGE_KEY, String(now))
      } catch {
        // Keep the connection working when storage is unavailable.
      }
    }
    mark()
    const timer = window.setInterval(mark, 30_000)
    return () => window.clearInterval(timer)
  }, [connection])

  useEffect(() => {
    if (connection === 'open' || connection === 'offline') setRetrying(false)
  }, [connection])

  useEffect(() => {
    connectionRef.current = connection
  }, [connection])

  /**
   * Tear the stream reader down and start the reconnect budget. Setting state
   * alone is not enough: the socket that went quiet never closes, so only a
   * restart of the loops releases the reader.
   */
  const markLinkDown = useCallback(() => {
    if (connectionRef.current !== 'open') return
    connectionRef.current = 'reconnecting'
    setConnection('reconnecting')
    setReconnectNonce(value => value + 1)
  }, [])

  const reportFailure = useCallback((
    cause: unknown,
    summary = '操作没有完成',
    action = '请检查连接后重试。',
  ) => {
    setError(feedbackFor(cause, summary, action))
    if (isLinkFailure(cause)) markLinkDown()
  }, [markLinkDown])

  const retryNow = useCallback(() => {
    setError(null)
    setGapNotice('')
    setRetrying(true)
    connectionRef.current = 'connecting'
    setConnection('connecting')
    setReconnectNonce(value => value + 1)
  }, [])

  /**
   * Detect silent stream failure while online, and keep a low-frequency health
   * probe alive after the reconnect budget settles at offline. A foreground,
   * focus, or browser-online transition probes immediately; a successful probe
   * restarts both event streams without requiring a manual tap.
   */
  useEffect(() => {
    if (connection === 'connecting' || connection === 'reconnecting') return
    let cancelled = false
    let probing = false
    let offlineAttempt = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const scheduleOfflineProbe = () => {
      if (cancelled || connectionRef.current !== 'offline') return
      if (timer !== null) clearTimeout(timer)
      const delay = offlineProbeDelay(offlineAttempt)
      offlineAttempt += 1
      timer = setTimeout(() => void check(false), delay)
    }

    const check = async (force: boolean) => {
      if (cancelled || probing) return
      if (
        connectionRef.current === 'open'
        && !force
        && Date.now() - lastEventAtRef.current < STREAM_IDLE_PROBE_MS
      ) return
      probing = true
      const alive = await probeHost()
      probing = false
      if (cancelled) return
      if (alive) {
        lastEventAtRef.current = Date.now()
        if (connectionRef.current === 'offline') retryNow()
      } else if (connectionRef.current === 'open') {
        markLinkDown()
      } else {
        scheduleOfflineProbe()
      }
    }

    if (connection === 'open') {
      timer = setInterval(() => void check(false), STREAM_IDLE_PROBE_MS / 2)
    } else {
      scheduleOfflineProbe()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void check(true)
    }
    const onForeground = () => void check(true)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onForeground)
    window.addEventListener('focus', onForeground)

    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', onForeground)
      window.removeEventListener('focus', onForeground)
    }
  }, [connection, markLinkDown, retryNow])

  useEffect(() => {
    pendingApprovalsRef.current = pendingApprovals
  }, [pendingApprovals])

  useEffect(() => {
    approvalDisplaysRef.current = approvalDisplays
  }, [approvalDisplays])

  useEffect(() => {
    if (approvalNotice === null) return
    const timer = window.setTimeout(() => {
      setApprovalNotice(current => current === approvalNotice ? null : current)
    }, 4_000)
    return () => window.clearTimeout(timer)
  }, [approvalNotice])

  const clearPendingQuestion = useCallback((rpcId: string) => {
    setApprovalNotice(null)
    setPendingQuestions(previous => previous.filter(item => item.rpcId !== rpcId))
    setQuestionDrafts(previous => {
      if (previous[rpcId] === undefined) return previous
      const next = { ...previous }
      delete next[rpcId]
      return next
    })
  }, [])

  const clearPendingApproval = useCallback((approvalId: string) => {
    setPendingApprovals(previous => {
      const next = withoutPendingApproval(previous, approvalId)
      pendingApprovalsRef.current = next
      return next
    })
  }, [])

  const recordResolvedApproval = useCallback((request: ApprovalRequest, outcome: string) => {
    if (resolvedApprovalIdsRef.current.has(request.approvalId)) return
    resolvedApprovalIdsRef.current.add(request.approvalId)
    const display = approvalDisplaysRef.current[request.approvalId]
    const resolvedAt = new Date().toISOString()
    const notice = resolvedApproval(request, outcome, display, resolvedAt)
    setResolvedApprovals(previous => {
      return withResolvedApproval(previous, request, outcome, display, resolvedAt)
    })
    setApprovalNotice(notice)
  }, [])

  const refreshAll = useCallback(async () => {
    try {
      const [nextHealth, nextHost, nextWorkspaces, nextSessions, nextPresets] = await Promise.all([
        transport.health(),
        transport.hostDescribe(),
        transport.listWorkspaces(),
        transport.listSessions(),
        transport.listAgentPresets(),
      ])
      setHealth(nextHealth)
      setHost(nextHost)
      setWorkspaces(nextWorkspaces.items)
      setArchivedSessionIds(nextWorkspaces.archivedSessionIds)
      setSessions(nextSessions.items)
      setAgentPresets(nextPresets.items)
      setError(null)
      setGapNotice('')
      // HTTP success refreshes data but does not prove the live event stream is
      // available. Only the WebSocket onOpen callback may report `open`.
    } catch (cause) {
      reportFailure(cause)
    }
  }, [reportFailure])

  const refreshSessionModels = useCallback(async (sessionId: string) => {
    setModelsLoading(true)
    try {
      const models = await transport.sessionModels(sessionId)
      if (selectedSessionIdRef.current === sessionId) setSessionModels(models)
      setError(null)
      return models
    } catch (cause) {
      reportFailure(cause)
      return null
    } finally {
      if (selectedSessionIdRef.current === sessionId) setModelsLoading(false)
    }
  }, [reportFailure])

  const refreshHistory = useCallback(async (sessionId: string) => {
    const generation = ++historyGenerationRef.current
    setHistoryLoading(true)
    setHistoryNotice(null)
    try {
      const page = await transport.sessionHistory({ sessionId })
      if (generation !== historyGenerationRef.current) return
      setHistory(page)
      historyRef.current = page
      setError(null)
      setGapNotice('')
    } catch (cause) {
      if (generation !== historyGenerationRef.current) return
      setHistory(null)
      historyRef.current = null
      setHistoryNotice(feedbackFor(cause, '无法加载执行记录', '请稍后重试。'))
      if (isLinkFailure(cause)) markLinkDown()
    } finally {
      if (generation === historyGenerationRef.current) setHistoryLoading(false)
    }
  }, [markLinkDown])

  const loadOlderHistory = useCallback(async (sessionId: string) => {
    if (loadingOlderRef.current) return
    const current = historyRef.current
    if (current === null || current.sessionId !== sessionId || current.hasMore === false) return
    const first = current.events[0]
    if (first === undefined) return

    loadingOlderRef.current = true
    setLoadingOlder(true)
    setHistoryNotice(null)
    const generation = historyGenerationRef.current
    try {
      const older = await transport.sessionHistory({ sessionId, beforeSeq: first.sequence })
      if (generation !== historyGenerationRef.current) return
      const tail = older.events.at(-1)
      if (tail !== undefined && tail.sequence + 1 !== first.sequence) {
        setHistoryNotice({ summary: '更早的执行记录不连续，已停止加载。' })
        setHistory(previous => previous === null ? previous : { ...previous, hasMore: false })
        historyRef.current = historyRef.current === null ? null : { ...historyRef.current, hasMore: false }
        return
      }
      setHistory(previous => {
        if (previous === null || previous.sessionId !== sessionId) return previous
        const existing = new Set(previous.events.map(event => event.eventId))
        const prepended = older.events.filter(event => existing.has(event.eventId) === false)
        const merged = [...prepended, ...previous.events].sort((a, b) => a.sequence - b.sequence)
        const next = { sessionId, events: merged, hasMore: older.hasMore }
        historyRef.current = next
        return next
      })
    } catch (cause) {
      if (generation === historyGenerationRef.current) {
        setHistoryNotice(feedbackFor(cause, '无法加载更早的执行记录', '请稍后重试。'))
      }
      if (isLinkFailure(cause)) markLinkDown()
    } finally {
      loadingOlderRef.current = false
      if (generation === historyGenerationRef.current) setLoadingOlder(false)
    }
  }, [markLinkDown])

  const loadApprovalDisplay = useCallback(async (request: ApprovalRequest): Promise<ApprovalDisplay> => {
    try {
      let page = historyRef.current?.sessionId === request.sessionId ? historyRef.current : null
      if (page === null) page = await transport.sessionHistory({ sessionId: request.sessionId })
      const toolEvent = page?.events.find(event =>
        event.type === 'tool/call' && record(event.payload)?.callId === request.callId,
      )
      const argumentsText = argumentsTextFor(toolEvent)
      return {
        request,
        toolTitle: toolTitleFor(request, toolEvent),
        ...(argumentsText !== undefined && { argumentsText }),
        ...(toolEvent !== undefined && toolEvent.view !== undefined && { callView: toolEvent.view }),
      }
    } catch {
      return { request, toolTitle: request.toolName }
    }
  }, [])

  const selectSession = useCallback((sessionId: string | null) => {
    historyGenerationRef.current += 1
    setSelectedSessionId(sessionId)
    selectedSessionIdRef.current = sessionId
    setHistory(null)
    setSessionModels(null)
    historyRef.current = null
    setHistoryNotice(null)
    setLoadingOlder(false)
    if (sessionId !== null) {
      void refreshHistory(sessionId)
      void refreshSessionModels(sessionId)
    }
  }, [refreshHistory, refreshSessionModels])

  useEffect(() => {
    void refreshAll()
    const controller = new AbortController()
    let disposed = false
    let attempt = 0
    let deadline: number | null = null

    void (async () => {
      while (!disposed) {
        try {
          setConnection('connecting')
          rebaselineStreamsRef.current.add('mux')
          lastEventAtRef.current = Date.now()
          // An idle Harness sends no frames, so the handshake — not the first
          // envelope — is what proves the link is up. Resync on the way in:
          // whatever happened while the stream was down was missed.
          const onOpen = () => {
            if (disposed) return
            attempt = 0
            deadline = null
            lastEventAtRef.current = Date.now()
            setConnection('open')
            void refreshAll()
          }
          for await (const envelope of transport.events('mux', controller.signal, onOpen)) {
            if (disposed) return
            attempt = 0
            lastEventAtRef.current = Date.now()
            setConnection('open')
            handleEnvelope(envelope)
          }
        } catch {
          // Fall through to the shared backoff below.
        }
        if (disposed) return
        const budgetEnd: number = deadline ?? Date.now() + RECONNECT_BUDGET_MS
        deadline = budgetEnd
        if (Date.now() >= budgetEnd) {
          setConnection('offline')
          return
        }
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 8_000
        attempt += 1
        setConnection('reconnecting')
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(delay, budgetEnd - Date.now()))))
      }
    })()

    return () => {
      disposed = true
      controller.abort()
    }
  }, [reconnectNonce])

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleRefresh = () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void refreshAll()
      }, 250)
    }

    void (async () => {
      let attempt = 0
      let deadline: number | null = null
      while (!disposed) {
        try {
          const onOpen = () => {
            attempt = 0
            deadline = null
          }
          for await (const envelope of transport.events('host', controller.signal, onOpen)) {
            if (disposed) return
            attempt = 0
            lastEventAtRef.current = Date.now()
            if (envelope.type.startsWith('host/')) scheduleRefresh()
          }
        } catch {
          // Reconnect below.
        }
        if (disposed) return
        // Give up on the same budget as the mux loop; the user restarts both.
        const budgetEnd: number = deadline ?? Date.now() + RECONNECT_BUDGET_MS
        deadline = budgetEnd
        if (Date.now() >= budgetEnd) return
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 8_000
        attempt += 1
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(delay, budgetEnd - Date.now()))))
      }
    })()

    return () => {
      disposed = true
      controller.abort()
      if (refreshTimer !== null) clearTimeout(refreshTimer)
    }
  }, [refreshAll, reconnectNonce])

  function handleEnvelope(envelope: RemoteEventEnvelope): void {
    if (rebaselineStreamsRef.current.delete(envelope.stream)) {
      // New WebSocket connection: establish a fresh sequence baseline and
      // recover state from HTTP RPC/history. The old connection's sequence
      // numbers must not produce a false 17-21 style gap after reconnect.
      trackerRef.current.resetStream(envelope.hostId, envelope.stream)
      setGapNotice('')
      void refreshAll()
      const selectedId = selectedSessionIdRef.current
      if (selectedId !== null) {
        void refreshHistory(selectedId)
        void refreshSessionModels(selectedId)
      }
    }

    const acceptance = trackerRef.current.accept(envelope)
    if (acceptance.kind === 'gap') {
      setGapNotice('正在补齐历史记录…')
      void refreshAll()
      const selectedId = selectedSessionIdRef.current
      if (selectedId !== null) {
        void refreshHistory(selectedId)
        void refreshSessionModels(selectedId)
      }
    }

    if (envelope.type === 'approval/requested') {
      const request = asApprovalRequest(envelope.payload)
      if (request !== undefined) {
        setApprovalNotice(null)
        setPendingApprovals(previous => {
          const next = previous.some(item => item.approvalId === request.approvalId) ? previous : [...previous, request]
          pendingApprovalsRef.current = next
          return next
        })
        void loadApprovalDisplay(request).then(display => {
          setApprovalDisplays(previous => ({ ...previous, [request.approvalId]: display }))
        })
      }
      return
    }
    if (envelope.type === 'approval/resolved') {
      const payload = record(envelope.payload)
      const approvalId = typeof payload?.approvalId === 'string' ? payload.approvalId : ''
      const outcome = typeof payload?.outcome === 'string' ? payload.outcome : ''
      if (approvalId !== '') {
        const request = pendingApprovalsRef.current.find(item => item.approvalId === approvalId)
        if (request !== undefined && outcome !== '') {
          recordResolvedApproval(request, outcome)
        }
        clearPendingApproval(approvalId)
      }
      return
    }
    if (envelope.type === 'question/requested') {
      const request = asQuestionRequest(envelope.payload)
      if (request !== undefined) {
        setApprovalNotice(null)
        setPendingQuestions(previous => (
          previous.some(item => item.rpcId === request.rpcId) ? previous : [...previous, request]
        ))
        setQuestionDrafts(previous => ({
          ...previous,
          [request.rpcId]: previous[request.rpcId] ?? emptyQuestionAnswers(request),
        }))
      }
      return
    }
    if (envelope.type === 'question/resolved') {
      const payload = record(envelope.payload)
      const rpcId = typeof payload?.rpcId === 'string' ? payload.rpcId : ''
      if (rpcId !== '') clearPendingQuestion(rpcId)
      return
    }
    if (envelope.type === 'session/queue' && envelope.sessionId !== undefined) {
      setQueuedBySession(previous => ({
        ...previous,
        [envelope.sessionId as string]: asQueuedItems(envelope.payload),
      }))
      return
    }

    if (envelope.type === 'session/event' && envelope.sessionId === selectedSessionIdRef.current) {
      const live = asLiveSessionEvent(envelope.payload)
      if (live !== undefined) {
        const view: SessionEventView = {
          eventId: envelope.eventId,
          sessionId: envelope.sessionId,
          sequence: live.event.seq,
          type: live.event.type,
          payload: live.event.data,
          timestamp: new Date(live.event.time).toISOString(),
          ...(live.view !== undefined && { view: live.view }),
        }
        setHistory(previous => {
          if (previous === null) return previous
          if (previous.events.some(item => item.eventId === view.eventId)) return previous
          const next = {
            ...previous,
            events: [...previous.events, view],
          }
          historyRef.current = next
          return next
        })
      }
    }
  }

  const searchSessions = useCallback(async (query: string) => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setSearchResults([])
      return
    }
    const visibleSessions = visibleTaskSessions(sessions, archivedSessionIds)
    const visibleIds = new Set(visibleSessions.map(session => session.sessionId))
    const localFallback = visibleSessions
      .filter(session => {
        const haystack = `${session.title ?? ''} ${session.cwd ?? ''} ${session.sessionId}`.toLowerCase()
        return haystack.includes(trimmed.toLowerCase())
      })
      .map(session => ({
        sessionId: session.sessionId,
        snippet: session.title ?? session.cwd ?? session.sessionId,
      }))

    try {
      const result = await transport.searchSessions(trimmed)
      const visibleResults = result.items.filter(item => visibleIds.has(item.sessionId))
      setSearchResults(visibleResults.length > 0 ? visibleResults : localFallback)
      setError(null)
    } catch {
      // Upstream full-text search is disabled in the default Harness web
      // profile (openAt: never). Fall back to title/cwd/sessionId matching.
      setSearchResults(localFallback)
      setError(null)
    }
  }, [archivedSessionIds, sessions])

  const createSession = useCallback(async (workspaceId?: string, idempotencyKey?: string, agentPreset?: string) => {
    try {
      const reusable = workspaceId === undefined
        ? undefined
        : reusableBlankSession(sessions, workspaceId, archivedSessionIds)
      let sessionId: string
      if (reusable !== undefined) {
        sessionId = reusable.sessionId
        if (agentPreset !== undefined && reusable.agentPreset !== agentPreset) {
          await transport.selectAgentPreset(
            { sessionId, agentPreset },
            `agent-preset:${sessionId}:${agentPreset}:${globalThis.crypto.randomUUID()}`,
          )
        }
      } else {
        sessionId = await transport.createSession(
          {
            ...(workspaceId !== undefined && { workspaceId }),
            ...(agentPreset !== undefined && { agentPreset }),
          },
          idempotencyKey,
        )
      }
      setSelectedSessionId(sessionId)
      selectedSessionIdRef.current = sessionId
      await refreshAll()
      await refreshHistory(sessionId)
      await refreshSessionModels(sessionId)
      return sessionId
    } catch (cause) {
      reportFailure(cause)
      return null
    }
  }, [archivedSessionIds, refreshAll, refreshHistory, refreshSessionModels, reportFailure, sessions])

  const selectAgentPreset = useCallback(async (sessionId: string, agentPreset: string): Promise<boolean> => {
    try {
      await transport.selectAgentPreset(
        { sessionId, agentPreset },
        `agent-preset:${sessionId}:${agentPreset}:${globalThis.crypto.randomUUID()}`,
      )
      await refreshAll()
      setError(null)
      return true
    } catch (cause) {
      reportFailure(cause, '无法切换工作模式', '请稍后重试。')
      return false
    }
  }, [refreshAll, reportFailure])

  const selectSessionModel = useCallback(async (input: SessionModelSelectInput): Promise<boolean> => {
    setModelsLoading(true)
    try {
      const selected = await transport.selectSessionModel(
        input,
        `session-model:${input.sessionId}:${input.provider}:${input.model}:${input.reasoningEffort ?? 'default'}:${globalThis.crypto.randomUUID()}`,
      )
      setSessionModels(previous => previous === null ? previous : { ...previous, current: selected, routable: true })
      setError(null)
      return true
    } catch (cause) {
      reportFailure(cause, '无法切换模型设置', '请稍后重试。')
      return false
    } finally {
      setModelsLoading(false)
    }
  }, [reportFailure])

  /**
   * Reports failures back to the caller rather than the global error banner: a
   * mistyped path is a correction the workspace form should explain in place,
   * not a connection-level problem.
   */
  const createWorkspace = useCallback(async (path: string): Promise<CreateWorkspaceResult> => {
    try {
      await transport.createWorkspace({ path })
      await refreshAll()
      return { ok: true }
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [refreshAll])

  const sendPrompt = useCallback(async (
    sessionId: string,
    text: string,
    mode: 'queue' | 'steer' = 'queue',
    idempotencyKey?: string,
  ): Promise<boolean> => {
    let optimisticId: string | undefined
    if (mode === 'queue') {
      const running = sessions.some(session => session.sessionId === sessionId && session.running)
      if (running) {
        optimisticId = `local:${Date.now()}:${Math.random()}`
        setQueuedBySession(previous => {
          const existing = previous[sessionId] ?? []
          return {
            ...previous,
            [sessionId]: [
              ...existing,
              { id: optimisticId as string, placement: 'queued', text },
            ],
          }
        })
      }
    }
    try {
      await transport.prompt({ sessionId, mode, text }, idempotencyKey)
      setSessions(previous => previous.map(session => (
        session.sessionId === sessionId && session.blank
          ? { ...session, blank: false, updatedAt: Date.now() }
          : session
      )))
      setError(null)
      return true
    } catch (cause) {
      if (optimisticId !== undefined) {
        setQueuedBySession(previous => ({
          ...previous,
          [sessionId]: (previous[sessionId] ?? []).filter(item => item.id !== optimisticId),
        }))
      }
      reportFailure(
        cause,
        '指令可能未送达',
        '可以直接重发，客户端会复用同一个操作标识，不会重复执行。',
      )
      return false
    }
  }, [reportFailure, sessions])

  const respondApproval = useCallback(async (
    request: ApprovalRequest,
    outcome: ApprovalDecision['outcome'],
  ): Promise<boolean> => {
    try {
      const result = await transport.approvalRespond({
        sessionId: request.sessionId,
        approvalId: request.approvalId,
        rpcId: request.rpcId,
        outcome,
      })
      clearPendingApproval(request.approvalId)
      if (!result.accepted) {
        setError({ summary: '该审批已处理或已过期，已从待办中移除。' })
        return false
      }
      recordResolvedApproval(request, outcome)
      setError(null)
      return true
    } catch (cause) {
      reportFailure(cause, '审批结果未能提交', '请确认连接后重试；收到成功确认前，待办会保留。')
      return false
    }
  }, [clearPendingApproval, recordResolvedApproval, reportFailure])

  const updateQuestionDraft = useCallback((rpcId: string, answers: QuestionAnswerItem[]) => {
    setQuestionDrafts(previous => ({ ...previous, [rpcId]: answers }))
  }, [])

  const respondQuestion = useCallback(async (
    request: QuestionRequest,
    answerOverride?: QuestionAnswerItem[],
  ): Promise<boolean> => {
    try {
      const answers = answerOverride ?? questionDrafts[request.rpcId] ?? emptyQuestionAnswers(request)
      const result = await transport.questionRespond({
        sessionId: request.sessionId,
        rpcId: request.rpcId,
        answer: { answers },
      })

      // The HTTP response is the authoritative acknowledgement from Harness.
      // Clear immediately instead of keeping a dead form around while waiting
      // for a question/resolved event that may be delayed or lost.
      clearPendingQuestion(request.rpcId)
      if (!result.accepted) {
        setError({ summary: '该问题已处理或已过期，已从待办中移除。' })
        return false
      }
      setError(null)
      return true
    } catch (cause) {
      reportFailure(cause)
      return false
    }
  }, [clearPendingQuestion, questionDrafts, reportFailure])

  const visibleSessions = useMemo(
    () => visibleTaskSessions(sessions, archivedSessionIds),
    [archivedSessionIds, sessions],
  )

  return {
    health,
    host,
    workspaces,
    archivedSessionIds,
    sessions,
    visibleSessions,
    agentPresets,
    sessionModels,
    modelsLoading,
    selectedSessionId,
    history,
    historyLoading,
    loadingOlder,
    historyNotice,
    loadOlderHistory,
    pendingApprovals,
    pendingQuestions,
    approvalDisplays,
    resolvedApprovals,
    approvalNotice,
    questionDrafts,
    updateQuestionDraft,
    queuedItems: selectedSessionId === null ? [] : (queuedBySession[selectedSessionId] ?? []),
    connection,
    lastConnectedAt,
    retrying,
    retryNow,
    gapNotice,
    error,
    refreshAll,
    refreshHistory,
    refreshSessionModels,
    searchResults,
    searchSessions,
    selectSession,
    createSession,
    selectAgentPreset,
    selectSessionModel,
    createWorkspace,
    sendPrompt,
    respondApproval,
    respondQuestion,
  }
}
