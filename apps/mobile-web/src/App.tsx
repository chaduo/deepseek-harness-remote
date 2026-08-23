import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { buildReviewTimeline, groupSessionsByWorkspace } from '@dsh-remote/domain'
import type {
  ModelSelection,
  ReviewMessageNode,
  ReviewNode,
  ReviewToolNode,
  SessionHistoryPage,
  SessionModels,
  SessionSearchItem,
  SessionSummary,
  WorkspaceSummary,
} from '@dsh-remote/domain'
import { innermostReason } from './errors.js'
import type { UserFeedback } from './errors.js'
import { useRemote } from './use-remote.js'
import type { CreateWorkspaceResult } from './use-remote.js'

type Tab = 'hosts' | 'tasks' | 'approval' | 'new'

interface WorkspaceFormError {
  hint: string
  reason?: string
}

const COLLAPSED_WORKSPACES_STORAGE_KEY = 'dsh-remote:collapsed-workspaces'
const UNGROUPED_WORKSPACE_KEY = '__ungrouped__'

function storedCollapsedWorkspaces(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_WORKSPACES_STORAGE_KEY)
    if (raw === null) return new Set()
    const value = JSON.parse(raw) as unknown
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

type IconName =
  | 'tasks'
  | 'check'
  | 'history'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'send'
  | 'alert'
  | 'laptop'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'

// Line icons at DSH's desktop weight; they inherit colour from the control they sit in.
const ICONS: Record<IconName, ReactNode> = {
  tasks: <><path d="M4 6h10" /><path d="M4 12h16" /><path d="M4 18h7" /></>,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  history: <><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" /><path d="M3.5 4.5V9.5H8.5" /><path d="M12 7.5V12l3 1.8" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20.5 4.5V10h-5.5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  send: <><path d="M12 19.5V5" /><path d="m5.5 11.5 6.5-6.5 6.5 6.5" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.4h.01" /></>,
  laptop: <><rect x="3.5" y="5" width="17" height="11.5" rx="2" /><path d="M2 19.5h20" /></>,
  'chevron-left': <path d="m15 5-7 7 7 7" />,
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  'chevron-down': <path d="m5 9 7 7 7-7" />,
}

function Icon(props: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[props.name]}
    </svg>
  )
}

export default function App() {
  const remote = useRemote()
  const [tab, setTab] = useState<Tab>('tasks')
  const [promptText, setPromptText] = useState('')
  const attentionCount = remote.pendingApprovals.length + remote.pendingQuestions.length
  const selectedSession = remote.sessions.find(session => session.sessionId === remote.selectedSessionId) ?? null
  const previousAttentionRef = useRef(attentionCount)

  useEffect(() => {
    document.title = attentionCount > 0 ? `(${attentionCount}) DSH Remote` : 'DSH Remote'
    if (attentionCount > previousAttentionRef.current) {
      navigator.vibrate?.([120, 80, 120])
    }
    previousAttentionRef.current = attentionCount
    return () => {
      document.title = 'DSH Remote'
    }
  }, [attentionCount])

  const openTask = (sessionId: string) => {
    remote.selectSession(sessionId)
    setTab('tasks')
  }

  // Nothing on the other pages is actionable without the Mac, and the phone
  // holds no Harness of its own, so the disconnected state replaces the body
  // and the tab bar rather than leaving dead controls behind.
  const disconnected = remote.connection === 'offline' || remote.retrying
  // A transport error while the link itself is down repeats what the status
  // line already says, in rawer words; keep the banner for real RPC failures.
  const noticeError = remote.connection === 'open' ? remote.error : null

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-copy">
          <div className="eyebrow">DSH Remote</div>
          <h1>{disconnected ? 'Mac 已离线' : pageTitle(tab, selectedSession)}</h1>
          <div className="connection-line">
            <span className={`connection-dot ${remote.connection}`} aria-hidden="true" />
            {connectionLabel(remote.connection)}
          </div>
        </div>
        <div className="topbar-actions">
          {!disconnected && (
            <button className="icon-button" aria-label="刷新" onClick={() => void remote.refreshAll()}>
              <Icon name="refresh" />
            </button>
          )}
        </div>
      </header>

      {!disconnected && (noticeError !== null || remote.gapNotice || remote.connection === 'reconnecting') && (
        <div
          className={`notice${remote.connection === 'reconnecting' && noticeError === null ? ' reconnecting' : ''}`}
          role="status"
          aria-live="polite"
        >
          {noticeError !== null && <FeedbackNotice feedback={noticeError} />}
          {remote.gapNotice && <div>{remote.gapNotice}</div>}
          {remote.connection === 'reconnecting' && noticeError === null && remote.gapNotice === '' && (
            <div>连接中断，正在自动重试。浏览仍可继续，写操作恢复后再提交。</div>
          )}
        </div>
      )}

      <main className={disconnected ? 'offline' : undefined}>
        {disconnected && (
          <OfflineView
            lastConnectedAt={remote.lastConnectedAt}
            retrying={remote.retrying}
            onRetry={remote.retryNow}
          />
        )}
        {!disconnected && tab === 'hosts' && <HostsView workspaceCount={remote.workspaces.length} health={remote.health} host={remote.host} />}
        {!disconnected && tab === 'tasks' && (
          <TasksView
            sessions={remote.visibleSessions}
            searchResults={remote.searchResults}
            workspaces={remote.workspaces}
            onSearch={remote.searchSessions}
            selectedSessionId={remote.selectedSessionId}
            history={remote.history}
            historyLoading={remote.historyLoading}
            queuedItems={remote.queuedItems}
            pendingApprovals={remote.pendingApprovals}
            pendingQuestions={remote.pendingQuestions}
            promptText={promptText}
            setPromptText={setPromptText}
            onSelect={remote.selectSession}
            onNew={() => setTab('new')}
            onOpenApproval={() => setTab('approval')}
            onSend={remote.sendPrompt}
            sessionModels={remote.sessionModels}
            modelsLoading={remote.modelsLoading}
            onLoadModels={remote.refreshSessionModels}
            onSelectModel={remote.selectSessionModel}
            historyNotice={remote.historyNotice}
            loadingOlder={remote.loadingOlder}
            onLoadOlder={sessionId => void remote.loadOlderHistory(sessionId)}
            onRefreshHistory={sessionId => void remote.refreshHistory(sessionId)}
            onCreateWorkspace={remote.createWorkspace}
          />
        )}
        {!disconnected && tab === 'approval' && (
          <ApprovalView
            approvals={remote.pendingApprovals}
            questions={remote.pendingQuestions}
            approvalDisplays={remote.approvalDisplays}
            resolvedApprovals={remote.resolvedApprovals}
            questionDrafts={remote.questionDrafts}
            onUpdateDraft={remote.updateQuestionDraft}
            onApprove={request => remote.respondApproval(request, 'allowed-once')}
            onReject={request => remote.respondApproval(request, 'rejected')}
            onAnswer={remote.respondQuestion}
            onOpenTask={openTask}
          />
        )}
        {!disconnected && tab === 'new' && (
          <NewTaskView
            workspaces={remote.workspaces}
            connection={remote.connection}
            agentPresets={remote.agentPresets}
            sessionModels={remote.sessionModels}
            modelsLoading={remote.modelsLoading}
            onCreate={remote.createSession}
            onSelectPreset={remote.selectAgentPreset}
            onLoadModels={remote.refreshSessionModels}
            onSelectModel={remote.selectSessionModel}
            onSend={remote.sendPrompt}
            onComplete={() => setTab('tasks')}
            onCancel={() => setTab('tasks')}
          />
        )}
      </main>

      {!disconnected && (
      <nav className="tabs" aria-label="主要导航">
        <TabButton
          icon="tasks"
          label="任务"
          active={tab === 'tasks'}
          onClick={() => {
            if (tab === 'tasks') remote.selectSession(null)
            setTab('tasks')
          }}
        />
        <TabButton icon="check" label="待办" badge={attentionCount} active={tab === 'approval'} onClick={() => setTab('approval')} />
        <TabButton icon="laptop" label="Mac" active={tab === 'hosts'} onClick={() => setTab('hosts')} />
      </nav>
      )}
      {!disconnected && tab !== 'new' && !(tab === 'tasks' && selectedSession !== null) && (
        <button className="new-task-fab" aria-label="新建任务" onClick={() => setTab('new')}>
          <Icon name="plus" />
          <span>新任务</span>
        </button>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {attentionCount > 0 ? `有 ${attentionCount} 个待办需要处理` : '当前没有待办'}
      </div>
    </div>
  )
}

function connectionLabel(state: ReturnType<typeof useRemote>['connection']): string {
  if (state === 'open') return 'Mac 在线'
  if (state === 'connecting') return '正在连接 Mac'
  if (state === 'reconnecting') return '连接中断，正在重试'
  return '已离线'
}

function pageTitle(tab: Tab, selected: SessionSummary | null): string {
  if (tab === 'hosts') return 'Mac 与工作区'
  if (tab === 'approval') return '等待处理'
  if (tab === 'new') return '新任务'
  return selected?.title ?? '任务'
}

function clientActionId(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`
}

function TabButton(props: {
  active: boolean
  onClick: () => void
  icon: IconName
  label: string
  badge?: number
  primary?: boolean
}) {
  return (
    <button
      className={`tab${props.active ? ' active' : ''}${props.primary === true ? ' primary' : ''}`}
      onClick={props.onClick}
      aria-current={props.active ? 'page' : undefined}
    >
      <span className="tab-icon" aria-hidden="true"><Icon name={props.icon} /></span>
      <span>{props.label}</span>
      {(props.badge ?? 0) > 0 && <span className="tab-badge">{props.badge}</span>}
    </button>
  )
}

function FeedbackNotice(props: { feedback: UserFeedback }) {
  return (
    <div className="feedback-notice">
      <strong>{props.feedback.summary}</strong>
      {props.feedback.action !== undefined && <div>{props.feedback.action}</div>}
      {props.feedback.detail !== undefined && (
        <details className="reasoning feedback-detail">
          <summary>技术详情</summary>
          <div>{props.feedback.detail}</div>
        </details>
      )}
    </div>
  )
}

function OfflineView(props: {
  lastConnectedAt: number | null
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <section className="page-section offline-view">
      <div className="offline-mark" aria-hidden="true"><Icon name="laptop" /></div>
      {props.lastConnectedAt !== null && <div className="offline-status">最后在线 {relativeTime(props.lastConnectedAt)}</div>}
      <p className="offline-hint">
        请确认这台 Mac 已唤醒并连着 Tailscale，DeepSeek Harness 与 Remote Host 都在运行。
      </p>
      <button className="offline-retry ghost" disabled={props.retrying} onClick={props.onRetry}>
        {props.retrying
          ? <span className="offline-spinner" aria-label="正在重新连接" />
          : '重新连接'}
      </button>
    </section>
  )
}

function HostsView(props: {
  workspaceCount: number
  health: ReturnType<typeof useRemote>['health']
  host: ReturnType<typeof useRemote>['host']
}) {
  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <div className="eyebrow">运行环境</div>
          <h2>Mac</h2>
        </div>
      </div>
      {props.host !== null && (
        <div className="card host-card">
          <div className="row">
            <div>
              <strong>这台 Mac</strong>
              <div className="muted path-line">{props.host.cwd}</div>
            </div>
            <span className="status running">在线</span>
          </div>
          <div className="host-stats">
            <div><strong>{props.host.model ?? '-'}</strong><span>模型</span></div>
            <div><strong>{props.host.attachedSessions}</strong><span>Harness 已挂载任务</span></div>
            <div><strong>{props.workspaceCount}</strong><span>工作区</span></div>
          </div>
          <div className="device-line">
            {props.health !== null && (
              <div>当前设备 · {props.health.principal.deviceName ?? props.health.principal.deviceId}</div>
            )}
            <div>Host · {props.host.hostId}</div>
          </div>
        </div>
      )}
    </section>
  )
}

function TasksView(props: {
  sessions: SessionSummary[]
  searchResults: SessionSearchItem[]
  workspaces: WorkspaceSummary[]
  onSearch: (query: string) => void
  selectedSessionId: string | null
  history: ReturnType<typeof useRemote>['history']
  historyLoading: boolean
  queuedItems: ReturnType<typeof useRemote>['queuedItems']
  pendingApprovals: ReturnType<typeof useRemote>['pendingApprovals']
  pendingQuestions: ReturnType<typeof useRemote>['pendingQuestions']
  promptText: string
  setPromptText: (value: string) => void
  onSelect: (sessionId: string | null) => void
  onNew: () => void
  onOpenApproval: () => void
  onSend: (sessionId: string, text: string, mode?: 'queue' | 'steer', idempotencyKey?: string) => Promise<boolean>
  sessionModels: SessionModels | null
  modelsLoading: boolean
  onLoadModels: (sessionId: string) => Promise<SessionModels | null>
  onSelectModel: (input: ModelSelection & { sessionId: string }) => Promise<boolean>
  historyNotice: UserFeedback | null
  loadingOlder: boolean
  onLoadOlder: (sessionId: string) => void
  onRefreshHistory: (sessionId: string) => void
  onCreateWorkspace: (path: string) => Promise<CreateWorkspaceResult>
}) {
  const selected = props.sessions.find(session => session.sessionId === props.selectedSessionId) ?? null
  const [searchText, setSearchText] = useState('')
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState(storedCollapsedWorkspaces)
  const groups = useMemo(
    () => groupSessionsByWorkspace(props.sessions, props.workspaces),
    [props.sessions, props.workspaces],
  )
  const attentionBySession = useMemo(() => {
    const counts = new Map<string, number>()
    for (const request of props.pendingApprovals) counts.set(request.sessionId, (counts.get(request.sessionId) ?? 0) + 1)
    for (const request of props.pendingQuestions) counts.set(request.sessionId, (counts.get(request.sessionId) ?? 0) + 1)
    return counts
  }, [props.pendingApprovals, props.pendingQuestions])

  useEffect(() => {
    const timer = window.setTimeout(() => props.onSearch(searchText), 250)
    return () => window.clearTimeout(timer)
  }, [searchText, props.onSearch])

  const toggleWorkspace = (workspaceKey: string) => {
    setCollapsedWorkspaces(previous => {
      const next = new Set(previous)
      if (next.has(workspaceKey)) next.delete(workspaceKey)
      else next.add(workspaceKey)
      try {
        window.localStorage.setItem(COLLAPSED_WORKSPACES_STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // Keep folding functional when storage is unavailable (for example, private browsing restrictions).
      }
      return next
    })
  }

  if (selected !== null) {
    return (
      <section className="page-section task-detail-page">
        <SessionDetail
          session={selected}
          history={props.history}
          historyLoading={props.historyLoading}
          queuedItems={props.queuedItems}
          attentionCount={attentionBySession.get(selected.sessionId) ?? 0}
          promptText={props.promptText}
          setPromptText={props.setPromptText}
          onBack={() => props.onSelect(null)}
          onOpenApproval={props.onOpenApproval}
          onSend={(text, mode, idempotencyKey) => props.onSend(selected.sessionId, text, mode, idempotencyKey)}
          sessionModels={props.sessionModels}
          modelsLoading={props.modelsLoading}
          onLoadModels={() => props.onLoadModels(selected.sessionId)}
          onSelectModel={selection => props.onSelectModel({ sessionId: selected.sessionId, ...selection })}
          historyNotice={props.historyNotice}
          loadingOlder={props.loadingOlder}
          onLoadOlder={() => props.onLoadOlder(selected.sessionId)}
          onRefreshHistory={() => props.onRefreshHistory(selected.sessionId)}
        />
      </section>
    )
  }

  return (
    <section className="page-section">
      <div className="section-heading row">
        <div>
          <div className="eyebrow">最近活动</div>
          <h2>任务</h2>
        </div>
      </div>

      <div className="search-field">
        <Icon name="search" />
        <input
          className="search"
          value={searchText}
          onChange={event => setSearchText(event.target.value)}
          placeholder="搜索任务或目录"
          aria-label="搜索任务"
        />
      </div>

      {searchText.trim() !== '' && (
        <div className="search-results">
          {props.searchResults.length === 0 && <div className="muted">无结果</div>}
          {props.searchResults.map(result => (
            <button
              className="session-row"
              key={result.sessionId}
              onClick={() => {
                setSearchText('')
                props.onSelect(result.sessionId)
              }}
            >
              <span className="session-title">{sessionTitle(props.sessions, result.sessionId)}</span>
              <span className="muted">{result.snippet}</span>
            </button>
          ))}
        </div>
      )}

      {groups.map((group, index) => {
        const workspaceKey = group.workspaceId ?? UNGROUPED_WORKSPACE_KEY
        const collapsed = collapsedWorkspaces.has(workspaceKey)
        const sessionListId = `workspace-sessions-${index}`
        return (
          <div className={`group${collapsed ? ' collapsed' : ''}`} key={workspaceKey}>
            <button
              className="group-heading"
              type="button"
              aria-expanded={!collapsed}
              aria-controls={sessionListId}
              onClick={() => toggleWorkspace(workspaceKey)}
            >
              <span className="group-heading-title">
                <span className="workspace-disclosure" aria-hidden="true"><Icon name="chevron-down" /></span>
                <span className="workspace-heading-copy">
                  <span>{group.title}</span>
                  {group.path !== undefined && <span>{group.path}</span>}
                </span>
              </span>
              <span className="workspace-task-count">{group.sessions.length} 个任务</span>
            </button>
            {!collapsed && (
              <div id={sessionListId}>
                {group.sessions.map(session => (
                  <button
                    className="session-row task-row"
                    key={session.sessionId}
                    onClick={() => props.onSelect(session.sessionId)}
                  >
                    <span className="task-row-main">
                      <span className={`task-state-dot${session.running ? ' running' : ''}`} aria-hidden="true" />
                      <span className="session-title">{session.title ?? '未命名任务'}</span>
                      {(attentionBySession.get(session.sessionId) ?? 0) > 0 && (
                        <span className="attention-badge">需处理 {attentionBySession.get(session.sessionId)}</span>
                      )}
                      <span className="chevron" aria-hidden="true"><Icon name="chevron-right" /></span>
                    </span>
                    <span className="task-row-meta">
                      <span>{session.running ? '运行中' : session.blank ? '尚未开始' : '已暂停'}</span>
                      <span>·</span>
                      <span>{relativeTime(session.updatedAt)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {props.sessions.length === 0 && props.workspaces.length === 0 && (
        <div className="empty-state">
          <strong>还没有任务</strong>
          <span>先添加一个工作区，再从手机发起第一项工作。</span>
          <button onClick={props.onNew}>创建任务</button>
        </div>
      )}
      <WorkspaceForm onCreateWorkspace={props.onCreateWorkspace} />
    </section>
  )
}

function WorkspaceForm(props: {
  onCreateWorkspace: (path: string) => Promise<CreateWorkspaceResult>
}) {
  const [workspacePath, setWorkspacePath] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<WorkspaceFormError | null>(null)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const focusInput = () => window.requestAnimationFrame(() => inputRef.current?.focus())
  const submitWorkspace = async () => {
    const path = workspacePath.trim()
    if (path === '' || creatingWorkspace) return
    if (!path.startsWith('/') && !path.startsWith('~')) {
      setWorkspaceError({ hint: '请填写 Mac 上的完整路径，例如 ~/Projects/my-app。' })
      focusInput()
      return
    }
    setCreatingWorkspace(true)
    const result = await props.onCreateWorkspace(path)
    setCreatingWorkspace(false)
    if (result.ok) {
      setWorkspaceError(null)
      setWorkspacePath('')
      setExpanded(false)
      return
    }
    setWorkspaceError({
      hint: 'Mac 上没能添加这个目录。请确认它已经存在，然后再试一次。',
      reason: innermostReason(result.reason),
    })
    focusInput()
  }

  return (
    <div className="workspace-create-section">
      <button
        className="workspace-create-toggle ghost"
        aria-expanded={expanded}
        aria-controls="workspace-create-form"
        onClick={() => {
          setExpanded(value => !value)
          setWorkspaceError(null)
        }}
      >
        <Icon name="plus" />
        <span>{expanded ? '取消添加工作区' : '添加工作区'}</span>
      </button>
      {expanded && (
        <div className="card workspace-form" id="workspace-create-form">
          <label htmlFor="workspace-path">Mac 上已有目录</label>
          <input
            ref={inputRef}
            id="workspace-path"
            value={workspacePath}
            aria-invalid={workspaceError !== null}
            aria-describedby="workspace-path-help"
            onChange={event => {
              setWorkspacePath(event.target.value)
              setWorkspaceError(null)
            }}
            placeholder="~/Projects/新目录"
          />
          {workspaceError === null
            ? <div className="muted" id="workspace-path-help">必须是 Mac 上已存在的目录。</div>
            : (
                <div className="field-error" id="workspace-path-help" role="alert">
                  <span>{workspaceError.hint}</span>
                  {workspaceError.reason !== undefined && (
                    <details className="reasoning field-error-detail">
                      <summary>技术详情</summary>
                      <div className="field-error-reason">{workspaceError.reason}</div>
                    </details>
                  )}
                </div>
              )}
          <button
            disabled={workspacePath.trim() === '' || creatingWorkspace}
            onClick={() => void submitWorkspace()}
          >
            {creatingWorkspace ? '正在添加…' : '添加工作区'}
          </button>
        </div>
      )}
    </div>
  )
}

function sessionTitle(sessions: SessionSummary[], sessionId: string): string {
  const session = sessions.find(item => item.sessionId === sessionId)
  return session?.title ?? '未命名任务'
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  return formatter.format(Math.round(hours / 24), 'day')
}

function SessionDetail(props: {
  session: SessionSummary
  history: SessionHistoryPage | null
  historyLoading: boolean
  queuedItems: ReturnType<typeof useRemote>['queuedItems']
  attentionCount: number
  promptText: string
  setPromptText: (value: string) => void
  onBack: () => void
  onOpenApproval: () => void
  onSend: (text: string, mode: 'queue' | 'steer', idempotencyKey: string) => Promise<boolean>
  sessionModels: SessionModels | null
  modelsLoading: boolean
  onLoadModels: () => Promise<SessionModels | null>
  onSelectModel: (selection: ModelSelection) => Promise<boolean>
  historyNotice: UserFeedback | null
  loadingOlder: boolean
  onLoadOlder: () => void
  onRefreshHistory: () => void
}) {
  const nodes = useMemo(() => buildReviewTimeline(props.history?.events ?? []), [props.history])
  const lastMessage = useMemo(
    () => [...nodes].reverse().find((node): node is ReviewMessageNode => node.kind === 'message' && node.role === 'assistant'),
    [nodes],
  )
  const [messageExpanded, setMessageExpanded] = useState(false)
  const [detailView, setDetailView] = useState<'conversation' | 'review'>('conversation')
  const [sending, setSending] = useState(false)
  const retryActionRef = useRef<{ fingerprint: string; key: string } | null>(null)
  const messageText = lastMessage?.text ?? ''

  const submit = async (mode: 'queue' | 'steer') => {
    const text = props.promptText.trim()
    if (text === '' || sending) return
    const fingerprint = `${mode}\u0000${text}`
    if (retryActionRef.current?.fingerprint !== fingerprint) {
      retryActionRef.current = { fingerprint, key: clientActionId('prompt') }
    }
    setSending(true)
    const sent = await props.onSend(text, mode, retryActionRef.current.key)
    setSending(false)
    if (sent) {
      retryActionRef.current = null
      props.setPromptText('')
    }
  }

  return (
    <div className="session-detail">
      <button className="back-button" onClick={props.onBack}>
        <Icon name="chevron-left" />
        <span>返回任务</span>
      </button>
      <div className="task-hero">
        <div className="row">
          <strong>{props.session.title ?? '未命名任务'}</strong>
          <span className={`status ${props.session.running ? 'running' : 'idle'}`}>
            {props.session.running ? '运行中' : props.session.blank ? '尚未开始' : '已暂停'}
          </span>
        </div>
        <div className="muted task-path">{props.session.cwd ?? '未设置目录'}</div>
        <div className="task-actions">
          {props.attentionCount > 0 && (
            <button className="attention-action small" onClick={props.onOpenApproval}>
              处理 {props.attentionCount} 个待办
            </button>
          )}
        </div>
      </div>

      <div className="detail-segments" aria-label="任务详情视图">
        <button aria-pressed={detailView === 'conversation'} onClick={() => setDetailView('conversation')}>对话</button>
        <button aria-pressed={detailView === 'review'} onClick={() => setDetailView('review')}>执行记录</button>
      </div>

      {detailView === 'review'
        ? (
            <ReviewView
              sessionId={props.session.sessionId}
              history={props.history}
              historyLoading={props.historyLoading}
              loadingOlder={props.loadingOlder}
              historyNotice={props.historyNotice}
              onLoadOlder={props.onLoadOlder}
              onRefresh={props.onRefreshHistory}
            />
          )
        : (
            <>
              {lastMessage !== undefined && (
                <div className={`last-message${messageExpanded ? ' expanded' : ' collapsed'}`}>
                  <div className="last-message-head">
                    <div className="muted">Agent 最新回复</div>
                    {messageText.length > 280 && (
                      <button className="ghost small" onClick={() => setMessageExpanded(value => !value)}>
                        {messageExpanded ? '收起' : '展开全文'}
                      </button>
                    )}
                  </div>
                  <div className="last-message-body">
                    <div className="message-text">{messageText}</div>
                  </div>
                </div>
              )}

              {props.historyLoading && props.history === null && <div className="card loading-card">正在同步任务进度…</div>}

              {lastMessage === undefined && props.historyLoading === false && (
                <div className="empty-state compact">
                  <strong>{props.session.blank ? '描述你要完成的工作' : '暂无可展示的消息'}</strong>
                  <span>指令会在这台 Mac 上的当前安全策略下执行。</span>
                </div>
              )}

              {props.queuedItems.length > 0 && (
                <div className="queued-box">
                  <div className="muted">已排队（{props.queuedItems.length}）</div>
                  {props.queuedItems.map(item => (
                    <div className="queued-item" key={item.id}>
                      <span className={`badge ${item.placement === 'steering' ? 'assistant' : 'tool'}`}>
                        {item.placement === 'steering' ? '追加' : '排队'}
                      </span>
                      <span>{item.text}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="task-composer">
                <div className="composer-card">
                  <textarea
                    className="composer-input"
                    value={props.promptText}
                    onChange={event => props.setPromptText(event.target.value)}
                    placeholder={props.session.running ? '追加说明或调整方向…' : '发送下一条指令…'}
                    rows={1}
                  />
                  <div className="composer-bar">
                    <ModelControls
                      models={props.sessionModels}
                      loading={props.modelsLoading}
                      onLoad={props.onLoadModels}
                      onSelect={props.onSelectModel}
                    />
                    <div className="composer-actions">
                      {props.session.running && (
                        <button
                          className="ghost"
                          disabled={sending || props.promptText.trim() === ''}
                          onClick={() => void submit('queue')}
                        >
                          排到下一轮
                        </button>
                      )}
                      <button
                        className="composer-send"
                        disabled={sending || props.promptText.trim() === ''}
                        onClick={() => void submit(props.session.running ? 'steer' : 'queue')}
                      >
                        <Icon name="send" />
                        <span>{sending ? '发送中…' : props.session.running ? '立即追加' : '发送指令'}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
    </div>
  )
}

function ModelControls(props: {
  models: SessionModels | null
  loading: boolean
  onLoad: () => Promise<SessionModels | null>
  onSelect: (selection: ModelSelection) => Promise<boolean>
}) {
  const [selecting, setSelecting] = useState(false)
  const current = props.models?.current
  const currentModel = props.models?.groups
    .find(group => group.id === current?.provider)
    ?.models.find(model => model.id === current?.model)
  const efforts = currentModel?.reasoning?.efforts ?? []

  const apply = async (selection: ModelSelection) => {
    if (selecting) return
    setSelecting(true)
    await props.onSelect(selection)
    setSelecting(false)
  }

  if (props.models === null) {
    return (
      <button className="model-setup-button ghost" disabled={props.loading} onClick={() => void props.onLoad()}>
        {props.loading ? '正在读取模型…' : '读取模型设置'}
      </button>
    )
  }

  return (
    <div className="model-controls" aria-label="模型与思考强度">
      <label>
        <span>模型</span>
        <select
          aria-label="模型"
          value={JSON.stringify([current?.provider ?? '', current?.model ?? ''])}
          disabled={selecting || props.loading}
          onChange={event => {
            const [provider, model] = JSON.parse(event.target.value) as [string, string]
            const nextModel = props.models?.groups.find(group => group.id === provider)?.models.find(item => item.id === model)
            void apply({
              provider,
              model,
              ...(nextModel?.reasoning?.defaultEffort !== undefined && { reasoningEffort: nextModel.reasoning.defaultEffort }),
            })
          }}
        >
          {props.models.groups.map(group => (
            <optgroup key={group.id} label={group.name}>
              {group.models.map(model => (
                <option key={model.id} value={JSON.stringify([group.id, model.id])}>{model.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label>
        <span>思考强度</span>
        <select
          aria-label="思考强度"
          value={current?.reasoningEffort ?? ''}
          disabled={selecting || props.loading || efforts.length === 0}
          onChange={event => {
            if (current === undefined) return
            void apply({
              provider: current.provider,
              model: current.model,
              ...(event.target.value !== '' && { reasoningEffort: event.target.value }),
            })
          }}
        >
          {current?.reasoningEffort === undefined && <option value="">默认</option>}
          {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
        </select>
      </label>
      {(selecting || props.loading) && <span className="model-status">正在应用…</span>}
      {props.models.routable === false && <span className="model-status danger-text">当前模型路由不可用</span>}
    </div>
  )
}

function NewTaskView(props: {
  workspaces: WorkspaceSummary[]
  connection: ReturnType<typeof useRemote>['connection']
  agentPresets: ReturnType<typeof useRemote>['agentPresets']
  sessionModels: SessionModels | null
  modelsLoading: boolean
  onCreate: (workspaceId?: string, idempotencyKey?: string, agentPreset?: string) => Promise<string | null>
  onSelectPreset: (sessionId: string, agentPreset: string) => Promise<boolean>
  onLoadModels: (sessionId: string) => Promise<SessionModels | null>
  onSelectModel: (input: ModelSelection & { sessionId: string }) => Promise<boolean>
  onSend: (sessionId: string, text: string, mode?: 'queue' | 'steer', idempotencyKey?: string) => Promise<boolean>
  onComplete: () => void
  onCancel: () => void
}) {
  const [workspaceId, setWorkspaceId] = useState('')
  const [text, setText] = useState('')
  const defaultPreset = props.agentPresets.find(preset => preset.isDefault && preset.broken === undefined)?.id ?? ''
  const [agentPreset, setAgentPreset] = useState('')
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null)
  const [promptAttempted, setPromptAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [presetSelecting, setPresetSelecting] = useState(false)
  const createRetryRef = useRef<{ fingerprint: string; key: string } | null>(null)
  const promptRetryRef = useRef<{ fingerprint: string; key: string } | null>(null)
  const effectivePreset = agentPreset || defaultPreset
  const missingRequirements = [
    ...(workspaceId === '' ? ['选择工作区'] : []),
    ...(text.trim() === '' ? ['填写任务说明'] : []),
  ]
  const startBlocked = missingRequirements.length > 0 || submitting || presetSelecting || props.connection !== 'open'

  const prepareSession = async (): Promise<string | null> => {
    if (createdSessionId !== null) return createdSessionId
    if (workspaceId === '') return null
    const fingerprint = `${workspaceId}\u0000${effectivePreset}`
    if (createRetryRef.current?.fingerprint !== fingerprint) {
      createRetryRef.current = { fingerprint, key: clientActionId('session-create') }
    }
    const sessionId = await props.onCreate(
      workspaceId,
      createRetryRef.current.key,
      effectivePreset || undefined,
    )
    if (sessionId !== null) setCreatedSessionId(sessionId)
    return sessionId
  }

  const configureModels = async () => {
    if (submitting || presetSelecting || props.connection !== 'open') return
    setSubmitting(true)
    const sessionId = await prepareSession()
    if (sessionId !== null) await props.onLoadModels(sessionId)
    setSubmitting(false)
  }

  const submit = async () => {
    if (text.trim() === '' || submitting || presetSelecting || props.connection !== 'open') return
    setSubmitting(true)
    let sessionId = createdSessionId
    if (sessionId === null) {
      sessionId = await prepareSession()
    }
    const prompt = text.trim()
    if (promptRetryRef.current?.fingerprint !== prompt) {
      promptRetryRef.current = { fingerprint: prompt, key: clientActionId('prompt') }
    }
    const sent = sessionId === null
      ? false
      : await props.onSend(sessionId, prompt, 'queue', promptRetryRef.current.key)
    setPromptAttempted(sessionId !== null && sent === false)
    setSubmitting(false)
    if (sent) {
      setText('')
      props.onComplete()
    }
  }

  return (
    <section className="page-section new-task-page">
      <button className="back-button" onClick={props.onCancel}>
        <Icon name="chevron-left" />
        <span>返回任务</span>
      </button>
      <div className="new-task-intro">
        <div className="new-task-mark" aria-hidden="true"><Icon name="plus" /></div>
        <div>
          <h2>从手机开始一项工作</h2>
          <p>选择 Mac 上的项目，描述目标；创建后可随时离开页面并继续跟进。</p>
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="new-task-workspace">工作区</label>
        <select
          id="new-task-workspace"
          value={workspaceId}
          required
          aria-required="true"
          aria-describedby="new-task-workspace-help"
          disabled={submitting || createdSessionId !== null}
          onChange={event => setWorkspaceId(event.target.value)}
        >
          <option value="" disabled>请选择 Mac 上的工作区</option>
          {props.workspaces.map(workspace => (
            <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
          ))}
        </select>
        <span className="form-hint" id="new-task-workspace-help">
          {workspaceId === ''
            ? props.workspaces.length === 0
              ? '电脑端尚未配置工作区，请先添加工作区。'
              : '仅可选择已从电脑端同步的工作区。'
            : props.workspaces.find(item => item.workspaceId === workspaceId)?.path}
        </span>
      </div>

      <div className="form-group">
        <label htmlFor="new-task-mode">工作模式</label>
        <select
          id="new-task-mode"
          value={effectivePreset}
          aria-describedby="new-task-mode-help"
          disabled={submitting || presetSelecting}
          onChange={event => {
            const next = event.target.value
            const previous = effectivePreset
            setAgentPreset(next)
            if (createdSessionId !== null) {
              setPresetSelecting(true)
              void props.onSelectPreset(createdSessionId, next).then(selected => {
                if (!selected) setAgentPreset(previous)
                setPresetSelecting(false)
              })
            }
          }}
        >
          {props.agentPresets.filter(preset => preset.broken === undefined).map(preset => (
            <option key={preset.id} value={preset.id}>
              {preset.name ?? preset.id}{preset.trust === 'user' ? '（自定义）' : ''}
            </option>
          ))}
        </select>
        <span className="form-hint" id="new-task-mode-help">
          {props.agentPresets.find(preset => preset.id === effectivePreset)?.description ?? '选择这个任务可使用的 Agent 工具组合。'}
        </span>
      </div>

      <div className="form-group">
        <label>模型与思考强度</label>
        {createdSessionId === null && (
          <span className="form-hint model-preparation-note">此操作会先在 Mac 上准备一个空白任务，再读取可选模型。</span>
        )}
        {createdSessionId === null ? (
          <button className="model-setup-button ghost" disabled={workspaceId === '' || submitting || presetSelecting || props.connection !== 'open'} onClick={() => void configureModels()}>
            {submitting ? '正在准备任务…' : '准备任务并设置模型'}
          </button>
        ) : (
          <ModelControls
            models={props.sessionModels}
            loading={props.modelsLoading}
            onLoad={() => props.onLoadModels(createdSessionId)}
            onSelect={selection => props.onSelectModel({ sessionId: createdSessionId, ...selection })}
          />
        )}
        <span className="form-hint">不设置时沿用 Harness 默认值；准备后选择会立即写入这个任务。</span>
      </div>

      <div className="form-group">
        <label htmlFor="new-task-prompt">任务说明</label>
        <textarea
          id="new-task-prompt"
          value={text}
          required
          aria-required="true"
          aria-describedby="new-task-prompt-help"
          onChange={event => setText(event.target.value)}
          placeholder="例如：检查手机端断线重连逻辑，修复问题并运行相关测试"
          rows={8}
        />
        <span className="form-hint" id="new-task-prompt-help">写清目标、约束和完成标准，后续仍可继续追加指令。</span>
      </div>

      {createdSessionId !== null && (
        <div className="retry-note">
          {promptAttempted
            ? '任务已创建。再次提交会继续使用同一个任务，不会重复创建。'
            : '模型设置已绑定到一个空白任务；发送说明时会继续使用它。'}
        </div>
      )}
      {props.connection !== 'open' && (
        <div className="retry-note">等待 Mac 重新连线后即可创建，当前输入会保留。</div>
      )}

      <button
        className="start-task-button"
        aria-disabled={startBlocked}
        aria-describedby="start-task-requirements"
        onClick={() => {
          if (!startBlocked) void submit()
        }}
      >
        {submitting ? '正在启动…' : promptAttempted ? '重试发送任务' : '在 Mac 上开始任务'}
      </button>
      <div className="start-task-requirements" id="start-task-requirements" role="status">
        {missingRequirements.length > 0
          ? `还需要：${missingRequirements.join('、')}`
          : props.connection !== 'open'
            ? 'Mac 重新在线后即可开始任务。'
            : '必填信息已完整，可以开始任务。'}
      </div>
    </section>
  )
}

function ApprovalView(props: {
  approvals: ReturnType<typeof useRemote>['pendingApprovals']
  questions: ReturnType<typeof useRemote>['pendingQuestions']
  approvalDisplays: ReturnType<typeof useRemote>['approvalDisplays']
  resolvedApprovals: ReturnType<typeof useRemote>['resolvedApprovals']
  questionDrafts: ReturnType<typeof useRemote>['questionDrafts']
  onUpdateDraft: (rpcId: string, answers: ReturnType<typeof useRemote>['questionDrafts'][string]) => void
  onApprove: (request: ReturnType<typeof useRemote>['pendingApprovals'][number]) => Promise<boolean>
  onReject: (request: ReturnType<typeof useRemote>['pendingApprovals'][number]) => Promise<boolean>
  onAnswer: (
    request: ReturnType<typeof useRemote>['pendingQuestions'][number],
    answers: ReturnType<typeof useRemote>['questionDrafts'][string],
  ) => Promise<boolean>
  onOpenTask: (sessionId: string) => void
}) {
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const total = props.approvals.length + props.questions.length

  const runAction = async (key: string, action: () => Promise<boolean>) => {
    if (pendingAction !== null) return
    setPendingAction(key)
    await action()
    setPendingAction(null)
  }

  return (
    <section className="page-section approval-page">
      <div className="section-heading">
        <div className="eyebrow">需要你的判断</div>
        <h2>{total > 0 ? `${total} 个待办` : '当前没有待办'}</h2>
        <p className="section-description">权限请求只允许一次；问题回答会直接影响 Agent 接下来的工作。</p>
      </div>

      {total === 0 && (
        <div className="empty-state approval-empty">
          <span className="empty-check" aria-hidden="true"><Icon name="check" /></span>
          <span>Agent 需要权限或补充信息时，会显示在这里。</span>
        </div>
      )}

      {props.resolvedApprovals[0] !== undefined && (
        <div className="approval-confirmation" role="status" aria-live="polite">
          {props.resolvedApprovals[0].outcome === 'allowed-once' ? '已允许一次' : '已拒绝'} · {' '}
          {props.resolvedApprovals[0].display?.toolTitle ?? props.resolvedApprovals[0].request.toolName}
        </div>
      )}

      {props.approvals.length > 0 && <h3 className="subsection-title">权限请求</h3>}
      {props.approvals.map(request => {
        const display = props.approvalDisplays[request.approvalId]
        const busy = pendingAction === `approval:${request.approvalId}`
        return (
          <div className="card attention-card" key={request.approvalId}>
            <div className="attention-card-head">
              <span className="attention-icon" aria-hidden="true"><Icon name="alert" /></span>
              <div>
                <strong>{display?.toolTitle ?? request.toolName}</strong>
              </div>
            </div>
            <button className="context-link" onClick={() => props.onOpenTask(request.sessionId)}>
              打开关联任务 <Icon name="chevron-right" />
            </button>
            <div className="approval-reason">{request.reason ?? 'Agent 请求执行此操作'}</div>
            {display?.argumentsText !== undefined && (
              <details className="reasoning">
                <summary>工具调用参数</summary>
                <pre className="preview">{display.argumentsText}</pre>
              </details>
            )}
            <div className="approval-actions">
              <button
                disabled={pendingAction !== null}
                onClick={() => void runAction(`approval:${request.approvalId}`, () => props.onApprove(request))}
              >
                {busy ? '提交中…' : '允许一次'}
              </button>
              <button
                className="danger secondary"
                disabled={pendingAction !== null}
                onClick={() => void runAction(`approval:${request.approvalId}`, () => props.onReject(request))}
              >
                拒绝
              </button>
            </div>
          </div>
        )
      })}

      {props.questions.length > 0 && <h3 className="subsection-title">Agent 问题</h3>}
      {props.questions.map(request => {
        const draft = props.questionDrafts[request.rpcId] ?? []
        const busy = pendingAction === `question:${request.rpcId}`
        const allAnswered = request.questions.every(question => {
          const answer = draft.find(item => item.id === question.id)
          const custom = customAnswers[`${request.rpcId}:${question.id}`]?.trim() ?? ''
          return (answer?.selected.length ?? 0) > 0 || custom !== ''
        })
        return (
          <div className="card attention-card question-card" key={request.rpcId}>
            <button className="context-link" onClick={() => props.onOpenTask(request.sessionId)}>
              打开关联任务 <Icon name="chevron-right" />
            </button>
            {request.questions.map(question => {
              const answer = draft.find(item => item.id === question.id)
              const selected = new Set(answer?.selected ?? [])
              return (
                <div className="question-block" key={question.id}>
                  <div><strong>{question.header ?? question.question}</strong></div>
                  <div className="muted">{question.question}</div>
                  <div className="options">
                    {(question.options ?? []).map(option => {
                      const active = selected.has(option.label)
                      return (
                        <button
                          className={`option${active ? ' active' : ''}`}
                          key={option.label}
                          aria-pressed={active}
                          onClick={() => {
                            const nextSelected = question.multiSelect === true
                              ? (active
                                  ? selectedValues(selected, option.label, true)
                                  : selectedValues(selected, option.label, false))
                              : [option.label]
                            props.onUpdateDraft(request.rpcId, draft.map(item =>
                              item.id === question.id ? { ...item, selected: nextSelected } : item,
                            ))
                          }}
                        >
                          {option.label}
                          {option.description !== undefined && <span className="muted"> · {option.description}</span>}
                        </button>
                      )
                    })}
                  </div>
                  <input
                    aria-label={`${question.header ?? question.question}的自定义答案`}
                    placeholder="自定义答案（可选）"
                    value={customAnswers[`${request.rpcId}:${question.id}`] ?? ''}
                    onChange={event => setCustomAnswers(previous => ({
                      ...previous,
                      [`${request.rpcId}:${question.id}`]: event.target.value,
                    }))}
                  />
                </div>
              )
            })}
            <button
              disabled={pendingAction !== null || !allAnswered}
              aria-describedby={`question-requirement-${request.rpcId}`}
              onClick={() => void runAction(`question:${request.rpcId}`, async () => {
                const answers = draft.map(answer => {
                  const customValue = customAnswers[`${request.rpcId}:${answer.id}`]?.trim()
                  return {
                    ...answer,
                    ...(customValue ? { custom: customValue } : {}),
                  }
                })
                props.onUpdateDraft(request.rpcId, answers)
                return props.onAnswer(request, answers)
              })}
            >
              {busy ? '提交中…' : '提交回答'}
            </button>
            {!allAnswered && (
              <div className="question-requirement" id={`question-requirement-${request.rpcId}`} role="status">
                请先为每个问题选择一项或填写自定义答案。
              </div>
            )}
          </div>
        )
      })}

      {props.resolvedApprovals.length > 0 && (
        <details className="resolved-section">
          <summary>最近审批记录（{props.resolvedApprovals.length}）</summary>
          {props.resolvedApprovals.map(item => (
            <div className="resolved-row" key={`${item.request.approvalId}:${item.resolvedAt}`}>
              <span>{item.display?.toolTitle ?? item.request.toolName}</span>
              <span className={`badge ${item.outcome === 'allowed-once' ? 'assistant' : 'tool'}`}>
                {item.outcome === 'allowed-once' ? '已允许一次' : '已拒绝'}
              </span>
            </div>
          ))}
        </details>
      )}
    </section>
  )
}

function selectedValues(selected: Set<string>, label: string, remove: boolean): string[] {
  const next = [...selected]
  if (remove) return next.filter(value => value !== label)
  if (!next.includes(label)) next.push(label)
  return next
}

type ReviewFilter = 'conversation' | 'messages' | 'tools' | 'changes' | 'status'

function ReviewView(props: {
  sessionId: string
  history: SessionHistoryPage | null
  historyLoading: boolean
  loadingOlder: boolean
  historyNotice: UserFeedback | null
  onLoadOlder: () => void
  onRefresh: () => void
}) {
  const [filter, setFilter] = useState<ReviewFilter>('conversation')
  const timelineRef = useRef<HTMLDivElement>(null)
  const autoScrolledSessionRef = useRef<string | null>(null)
  const nodes = useMemo(
    () => buildReviewTimeline(props.history?.events ?? []),
    [props.history],
  )
  const filtered = useMemo(
    () => nodes.filter(node => reviewNodeMatches(node, filter)),
    [nodes, filter],
  )
  const internalNodes = useMemo(
    () => nodes.filter(node => node.kind === 'status' || node.kind === 'raw'),
    [nodes],
  )
  const finalSeq = useMemo(() => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index]
      if (node !== undefined && node.kind === 'message' && node.role === 'assistant' && node.partial !== true && node.text !== '') {
        return node.seq
      }
    }
    return undefined
  }, [nodes])
  const eventCount = props.history?.events.length ?? 0
  const firstSeq = props.history?.events[0]?.sequence

  useEffect(() => {
    if (eventCount === 0 || props.historyLoading || autoScrolledSessionRef.current === props.sessionId) return
    autoScrolledSessionRef.current = props.sessionId
    const frame = window.requestAnimationFrame(() => {
      const userMessages = timelineRef.current?.querySelectorAll('.review-card.message.user')
      const content = timelineRef.current?.querySelectorAll('.review-card.message, .review-card.tool')
      const target = userMessages !== undefined && userMessages.length > 0
        ? userMessages.item(userMessages.length - 1)
        : content?.item((content?.length ?? 0) - 1)
      target?.scrollIntoView({ block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [eventCount, props.historyLoading, props.sessionId])

  return (
    <section className="review-view">
      <div className="review-toolbar">
        <select value={filter} onChange={event => setFilter(event.target.value as ReviewFilter)} aria-label="筛选执行记录">
          <option value="conversation">对话与工具</option>
          <option value="messages">消息</option>
          <option value="tools">工具</option>
          <option value="changes">文件与测试</option>
          <option value="status">内部事件</option>
        </select>
        <button
          className="ghost small"
          disabled={props.historyLoading}
          onClick={props.onRefresh}
        >
          刷新
        </button>
      </div>

      {props.historyNotice !== null && <div className="review-notice"><FeedbackNotice feedback={props.historyNotice} /></div>}

      {props.historyLoading && props.history === null && (
        <div className="card loading-card">加载历史中…</div>
      )}

      {props.historyLoading === false && eventCount === 0 && (
        <div className="card muted">暂无事件</div>
      )}

      {props.history !== null && props.history.hasMore && (
        <button
          className="ghost load-older"
          disabled={props.loadingOlder}
          onClick={props.onLoadOlder}
        >
          {props.loadingOlder ? '加载中…' : `加载更早（当前从 #${firstSeq ?? 0} 开始）`}
        </button>
      )}

      {eventCount > 0 && (
        <div className="muted review-summary">
          {eventCount.toLocaleString()} 个原始事件折叠为 {nodes.length.toLocaleString()} 条记录；当前显示 {filtered.length.toLocaleString()} 条
        </div>
      )}

      <div className="timeline" ref={timelineRef}>
        {filtered.map(node => <ReviewNodeView key={`${node.kind}:${node.seq}`} node={node} final={node.kind === 'message' && node.seq === finalSeq} />)}
        {filter === 'conversation' && internalNodes.length > 0 && (
          <details className="internal-events">
            <summary>内部事件（{internalNodes.length}）</summary>
            {internalNodes.map(node => (
              <ReviewNodeView key={`internal:${node.kind}:${node.seq}`} node={node} final={false} />
            ))}
          </details>
        )}
      </div>
    </section>
  )
}

function reviewNodeMatches(node: ReviewNode, filter: ReviewFilter): boolean {
  if (filter === 'conversation') return node.kind === 'message' || node.kind === 'tool'
  if (filter === 'messages') return node.kind === 'message'
  if (filter === 'tools') return node.kind === 'tool'
  if (filter === 'changes') {
    if (node.kind !== 'tool') return false
    const card = toolCardFor(node)
    return card === 'terminal' || card === 'diff' || card === 'read' || card === 'search'
  }
  return node.kind === 'status' || node.kind === 'raw'
}

function ReviewNodeView(props: { node: ReviewNode; final: boolean }) {
  const node = props.node
  if (node.kind === 'turn') {
    return <div className="review-turn"><span>Turn {node.turn}</span><span className="muted">{new Date(node.timestamp).toLocaleTimeString()}</span></div>
  }
  if (node.kind === 'step') {
    return <div className="review-step muted">Step {node.step}</div>
  }
  if (node.kind === 'message') return <MessageCard node={node} final={props.final} />
  if (node.kind === 'tool') return <ToolCard node={node} />
  if (node.kind === 'status') return <StatusRow node={node} />
  return <RawRow node={node} />
}

function MessageCard(props: { node: ReviewMessageNode; final: boolean }) {
  const node = props.node
  const [expanded, setExpanded] = useState(props.final)
  const longText = node.text.length > 320
  const visibleText = expanded || longText === false ? node.text : `${node.text.slice(0, 320)}…`
  return (
    <div className={`review-card message ${node.role}${props.final ? ' final' : ''}${node.partial === true ? ' partial' : ''}`}>
      <div className="review-card-head">
        <button className="review-head-button" onClick={() => setExpanded(value => !value)}>
          <span className={`badge ${node.role}`}>{node.role === 'user' ? '用户' : props.final ? '最终结论' : node.partial === true ? 'Agent · 进行中' : 'Agent'}</span>
          <span className="muted">#{node.seq} · {new Date(node.timestamp).toLocaleTimeString()}</span>
        </button>
        <CopyButton value={node.text} label="复制" />
      </div>
      {node.reasoning !== undefined && (
        <details className="reasoning">
          <summary>思考过程</summary>
          <pre className="preview">{node.reasoning}</pre>
        </details>
      )}
      {node.text !== '' && <div className="message-text">{visibleText}</div>}
      {longText && (
        <button className="ghost small" onClick={() => setExpanded(value => !value)}>
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
    </div>
  )
}


type ViewRecord = Record<string, unknown>

function asViewRecord(value: unknown): ViewRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as ViewRecord
  return typeof record.card === 'string' ? record : undefined
}

function toolCardFor(node: ReviewToolNode): string | undefined {
  const result = asViewRecord(node.resultView)?.card
  const call = asViewRecord(node.callView)?.card
  return typeof result === 'string' ? result : typeof call === 'string' ? call : undefined
}

function ToolCard(props: { node: ReviewToolNode }) {
  const node = props.node
  const [expanded, setExpanded] = useState(false)
  const card = toolCardFor(node)
  const cardName = card === undefined ? node.name : card
  const statusKey = node.resultText !== undefined
    ? node.resultIsError === true ? 'error' : 'done'
    : 'running'
  const status = statusKey === 'error' ? '失败' : statusKey === 'done' ? '完成' : '运行中'
  return (
    <div className={`review-card tool status-${statusKey}`}>
      <div className="review-card-head">
        <button className="review-head-button" onClick={() => setExpanded(value => !value)}>
          <span className="badge tool">{cardName}</span>
          <span className="tool-title">{node.title}</span>
          <span className="muted">#{node.seq} · {status}</span>
        </button>
      </div>
      {expanded && <ToolDetail node={node} view={asViewRecord(node.resultView) ?? asViewRecord(node.callView)} />}
    </div>
  )
}

function ToolDetail(props: { node: ReviewToolNode; view: ViewRecord | undefined }) {
  const node = props.node
  const view = props.view
  if (view !== undefined && view.card === 'terminal') return <TerminalDetail node={node} view={view} />
  if (view !== undefined && view.card === 'diff') return <DiffDetail view={view} />
  if (view !== undefined && view.card === 'read') return <ReadDetail view={view} />
  if (view !== undefined && view.card === 'search') return <SearchDetail view={view} />
  if (view !== undefined && view.card === 'web') return <WebDetail view={view} />
  return <GenericDetail node={node} view={view} />
}

function TerminalDetail(props: { node: ReviewToolNode; view: ViewRecord }) {
  const node = props.node
  const output = typeof props.view.output === 'string'
    ? props.view.output
    : node.resultText ?? ''
  const exitCode = typeof props.view.exitCode === 'number' ? String(props.view.exitCode) : undefined
  const signal = typeof props.view.signal === 'string' ? props.view.signal : undefined
  const capped = output.length > 12000
  return (
    <div className="tool-detail">
      {node.argumentsText !== undefined && node.title === node.name && <pre className="preview">{node.argumentsText}</pre>}
      <div className="status-pills">
        {exitCode !== undefined && <span className={`status-pill ${exitCode === '0' ? 'ok' : 'bad'}`}>exit {exitCode}</span>}
        {signal !== undefined && <span className="status-pill bad">{signal}</span>}
        <CopyButton value={output} label="复制输出" />
      </div>
      <pre className="preview">{capped ? `${output.slice(0, 12000)}\n…` : output}</pre>
      {capped && <div className="muted">输出过长，仅显示前 12000 字符</div>}
    </div>
  )
}

function DiffDetail(props: { view: ViewRecord }) {
  const diffs = Array.isArray(props.view.diffs) ? props.view.diffs : []
  if (diffs.length === 0) return <div className="tool-detail muted">没有 diff 内容</div>
  return (
    <div className="tool-detail">
      {diffs.map((value, index) => {
        const diff = asRecord(value)
        const path = typeof diff?.path === 'string' ? diff.path : `文件 ${index + 1}`
        const oldText = typeof diff?.oldText === 'string' ? diff.oldText : null
        const newText = typeof diff?.newText === 'string' ? diff.newText : ''
        return (
          <div className="diff-file" key={`${path}:${index}`}>
            <div className="diff-path">{path}</div>
            {oldText === null
              ? <pre className="preview diff-add">{newText}</pre>
              : (
                  <>
                    <pre className="preview diff-old">{oldText}</pre>
                    <pre className="preview diff-add">{newText}</pre>
                  </>
                )}
          </div>
        )
      })}
    </div>
  )
}

function ReadDetail(props: { view: ViewRecord }) {
  const path = typeof props.view.path === 'string' ? props.view.path : ''
  const totalLines = typeof props.view.totalLines === 'number' ? props.view.totalLines : undefined
  const lines = Array.isArray(props.view.lines) ? props.view.lines : []
  return (
    <div className="tool-detail">
      <div className="diff-path">{path}{totalLines !== undefined ? ` · 共 ${totalLines} 行` : ''}</div>
      <pre className="preview code">
        {lines.map(line => {
          const record = asRecord(line)
          const number = typeof record?.number === 'number' ? record.number : ''
          const text = typeof record?.text === 'string' ? record.text : ''
          return `${String(number).padStart(5, ' ')}  ${text}`
        }).join('\n')}
      </pre>
    </div>
  )
}

function SearchDetail(props: { view: ViewRecord }) {
  if (props.view.shape === 'matches') {
    const files = Array.isArray(props.view.files) ? props.view.files : []
    return (
      <div className="tool-detail">
        {props.view.truncated === true && <div className="muted">结果已截断，总数 {String(props.view.total ?? '?')}</div>}
        {files.map((value, index) => {
          const file = asRecord(value)
          const path = typeof file?.path === 'string' ? file.path : `结果 ${index + 1}`
          const matches = Array.isArray(file?.matches) ? file.matches : []
          return (
            <details className="search-file" key={`${path}:${index}`}>
              <summary>{path} ({matches.length})</summary>
              <pre className="preview">
                {matches.map(match => {
                  const record = asRecord(match)
                  const lineNumber = typeof record?.lineNumber === 'number' ? record.lineNumber : ''
                  const line = typeof record?.line === 'string' ? record.line : ''
                  return `${String(lineNumber).padStart(5, ' ')}  ${line}`
                }).join('\n')}
              </pre>
            </details>
          )
        })}
      </div>
    )
  }
  if (props.view.shape === 'paths') {
    const paths = Array.isArray(props.view.paths) ? props.view.paths.filter(value => typeof value === 'string') : []
    return (
      <div className="tool-detail">
        {props.view.truncated === true && <div className="muted">结果已截断，总数 {String(props.view.total ?? '?')}</div>}
        <pre className="preview">{paths.join('\n')}</pre>
      </div>
    )
  }
  return <GenericDetail node={{ name: 'search', title: 'Search' }} view={props.view} />
}

function WebDetail(props: { view: ViewRecord }) {
  const sources = Array.isArray(props.view.sources) ? props.view.sources : []
  return (
    <div className="tool-detail">
      {typeof props.view.answer === 'string' && props.view.answer !== '' && <div className="message-text">{props.view.answer}</div>}
      {sources.map((value, index) => {
        const source = asRecord(value)
        return (
          <div className="web-source" key={typeof source?.url === 'string' ? source.url : index}>
            <div><strong>{typeof source?.title === 'string' ? source.title : typeof source?.url === 'string' ? source.url : `来源 ${index + 1}`}</strong></div>
            {typeof source?.snippet === 'string' && <div className="muted">{source.snippet}</div>}
          </div>
        )
      })}
    </div>
  )
}

function GenericDetail(props: { node: Pick<ReviewToolNode, 'name' | 'title' | 'argumentsText' | 'resultText'>; view: ViewRecord | undefined }) {
  const node = props.node
  const rawInput = props.view?.rawInput
  const contentText = textFromBlocks(props.view?.content)
  return (
    <div className="tool-detail">
      {node.argumentsText !== undefined && <pre className="preview">{node.argumentsText}</pre>}
      {rawInput !== undefined && <pre className="preview">{formatUnknown(rawInput)}</pre>}
      {contentText !== '' && <pre className="preview">{contentText}</pre>}
      {node.resultText !== undefined && node.resultText !== '' && <pre className="preview">{node.resultText}</pre>}
      {node.argumentsText === undefined && node.resultText === undefined && contentText === '' && <div className="muted">无详情</div>}
    </div>
  )
}

function StatusRow(props: { node: Extract<ReviewNode, { kind: 'status' }> }) {
  const node = props.node
  return (
    <details className="review-status">
      <summary>
        <span>{node.label}{node.detail !== '' ? ` · ${node.detail}` : ''}</span>
        <span className="muted">#{node.seq}</span>
      </summary>
      <pre className="preview">{formatUnknown(node.payload)}</pre>
    </details>
  )
}

function RawRow(props: { node: Extract<ReviewNode, { kind: 'raw' }> }) {
  const node = props.node
  return (
    <details className="review-status raw">
      <summary>
        <span className="muted">{node.label}</span>
        <span className="muted">#{node.seq}</span>
      </summary>
      <pre className="preview">{formatUnknown({ type: node.eventType, payload: node.payload })}</pre>
    </details>
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as Record<string, unknown>
}

function textFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content) === false) return ''
  let text = ''
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    if (typeof record.text === 'string') {
      text = text === '' ? record.text : `${text}\n${record.text}`
    } else if (record.content !== undefined) {
      const nested = textFromBlocks(record.content)
      if (nested !== '') text = text === '' ? nested : `${text}\n${nested}`
    }
  }
  return text
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function CopyButton(props: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async () => {
    if (navigator.clipboard === undefined) {
      setState('failed')
      return
    }
    try {
      await navigator.clipboard.writeText(props.value)
      setState('copied')
      window.setTimeout(() => setState('idle'), 1600)
    } catch {
      setState('failed')
    }
  }

  return (
    <button className="ghost small" onClick={() => void copy()} aria-live="polite">
      {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : props.label}
    </button>
  )
}
