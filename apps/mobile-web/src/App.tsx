import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { buildReviewTimeline } from '@dsh-remote/domain'
import type {
  ModelSelection,
  CheckDefinitionSummary,
  CheckRun,
  PreviewDefinitionSummary,
  PreviewOpenResult,
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
import { questionAnswersForSubmit, questionAnswersReady } from './remote-state.js'
import { useRemote } from './use-remote.js'
import type { CreateWorkspaceResult, PushState } from './use-remote.js'
import { DraftStore } from './draft-store.js'
import { composerCopy } from './composer-model.js'
import { compactConversationText, compactReasoningLabel, conversationNodes } from './conversation-model.js'
import {
  displayHostName,
  sortTaskChats,
  taskChatsForProject,
  toggleTaskProject,
} from './task-page-model.js'

type Tab = 'hosts' | 'tasks' | 'approval' | 'new'

interface WorkspaceFormError {
  hint: string
  reason?: string
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
  | 'menu'
  | 'more'
  | 'folder'
  | 'edit'
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
  menu: <><path d="M5 7h14" /><path d="M5 12h14" /><path d="M5 17h14" /></>,
  more: <><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" /></>,
  folder: <><path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9.5a2 2 0 0 1 2-2Z" /></>,
  edit: <><path d="m14.5 5.5 4 4" /><path d="m4 20 4.5-1 9.7-9.7a2.1 2.1 0 0 0-3-3L5.5 16z" /></>,
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
  const draftStore = useMemo(() => new DraftStore(), [])
  const [, setDraftRevision] = useState(0)
  const [tab, setTab] = useState<Tab>('tasks')
  const [taskMenuOpen, setTaskMenuOpen] = useState(false)
  const [newTaskWorkspaceId, setNewTaskWorkspaceId] = useState<string | undefined>()
  const attentionCount = remote.pendingApprovals.length + remote.pendingQuestions.length
  const selectedSession = remote.sessions.find(session => session.sessionId === remote.selectedSessionId) ?? null
  const promptText = remote.selectedSessionId === null ? '' : draftStore.get(remote.selectedSessionId)
  const draftVersion = remote.selectedSessionId === null ? 0 : draftStore.version(remote.selectedSessionId)
  const previousAttentionRef = useRef(attentionCount)

  const setPromptText = (value: string) => {
    if (remote.selectedSessionId === null) return
    draftStore.set(remote.selectedSessionId, value)
    setDraftRevision(previous => previous + 1)
  }

  const clearDraftIfVersion = (version: number) => {
    if (remote.selectedSessionId === null) return
    if (draftStore.clearIfVersion(remote.selectedSessionId, version)) {
      setDraftRevision(previous => previous + 1)
    }
  }

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

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get('session')
    if (sessionId === null || remote.connection === 'offline') return
    remote.selectSession(sessionId)
    setTab('tasks')
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`)
  }, [remote.connection, remote.selectSession])

  const openTask = (sessionId: string) => {
    remote.selectSession(sessionId)
    setTab('tasks')
  }

  // Nothing on the other pages is actionable without the Mac, and the phone
  // holds no Harness of its own, so the disconnected state replaces the body
  // and the tab bar rather than leaving dead controls behind.
  const disconnected = remote.connection === 'offline' || remote.retrying
  const taskHome = !disconnected && tab === 'tasks' && selectedSession === null
  // A transport error while the link itself is down repeats what the status
  // line already says, in rawer words; keep the banner for real RPC failures.
  const noticeError = remote.connection === 'open' ? remote.error : null

  return (
    <div className="app">
      <header className={taskHome ? 'topbar task-home-topbar' : 'topbar'}>
        {taskHome ? (
          <TaskHomeHeader
            connection={remote.connection}
            hostLabel={displayHostName(window.location.hostname)}
            onToggleMenu={() => setTaskMenuOpen(previous => !previous)}
          />
        ) : (
          <>
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
          </>
        )}
      </header>

      {taskHome && taskMenuOpen && (
        <TaskNavigationMenu
          activeTab={tab}
          attentionCount={attentionCount}
          onSelect={nextTab => {
            setTab(nextTab)
            setTaskMenuOpen(false)
            if (nextTab === 'tasks') remote.selectSession(null)
          }}
          onRefresh={() => {
            setTaskMenuOpen(false)
            void remote.refreshAll()
          }}
        />
      )}

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

      <main className={disconnected ? 'offline' : taskHome ? 'task-home-main' : undefined}>
        {disconnected && (
          <OfflineView
            lastConnectedAt={remote.lastConnectedAt}
            retrying={remote.retrying}
            onRetry={remote.retryNow}
          />
        )}
        {!disconnected && tab === 'hosts' && (
          <HostsView
            workspaceCount={remote.workspaces.length}
            health={remote.health}
            host={remote.host}
            pushState={remote.pushState}
            onEnablePush={remote.enablePush}
            onDisablePush={remote.disablePush}
          />
        )}
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
            checks={remote.checks}
            checkRuns={remote.checkRuns}
            onRunCheck={remote.runCheck}
            onCancelCheck={remote.cancelCheck}
            previews={remote.previews}
            onOpenPreview={remote.openPreview}
            promptText={promptText}
            setPromptText={setPromptText}
            draftVersion={draftVersion}
            clearDraftIfVersion={clearDraftIfVersion}
            onSelect={sessionId => {
              setTaskMenuOpen(false)
              remote.selectSession(sessionId)
            }}
            onNew={workspaceId => {
              setTaskMenuOpen(false)
              setNewTaskWorkspaceId(workspaceId)
              setTab('new')
            }}
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
            approvalNotice={remote.approvalNotice}
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
            initialWorkspaceId={newTaskWorkspaceId}
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

      {!disconnected && !taskHome && (
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
      {!disconnected && !taskHome && tab !== 'new' && !(tab === 'tasks' && selectedSession !== null) && (
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

function TaskHomeHeader(props: {
  connection: ReturnType<typeof useRemote>['connection']
  hostLabel: string
  onToggleMenu: () => void
}) {
  return (
    <div className="task-home-header">
      <button className="task-home-circle" aria-label="打开导航" onClick={props.onToggleMenu}>
        <Icon name="menu" />
      </button>
      <div className="task-home-header-copy">
        <h1>远程</h1>
        <div className="task-home-host">
          <span className={'connection-dot ' + props.connection} aria-hidden="true" />
          <Icon name="laptop" />
          <span>{props.hostLabel}</span>
        </div>
      </div>
      <button className="task-home-circle" aria-label="更多操作" onClick={props.onToggleMenu}>
        <Icon name="more" />
      </button>
    </div>
  )
}

function TaskNavigationMenu(props: {
  activeTab: Tab
  attentionCount: number
  onSelect: (tab: 'tasks' | 'approval' | 'hosts') => void
  onRefresh: () => void
}) {
  return (
    <div className="task-navigation-menu" role="dialog" aria-label="导航">
      <button className={'task-navigation-item' + (props.activeTab === 'tasks' ? ' active' : '')} onClick={() => props.onSelect('tasks')}>
        <Icon name="tasks" />
        <span>任务</span>
      </button>
      <button className={'task-navigation-item' + (props.activeTab === 'approval' ? ' active' : '')} onClick={() => props.onSelect('approval')}>
        <Icon name="check" />
        <span>待办</span>
        {props.attentionCount > 0 && <span className="task-navigation-badge">{props.attentionCount}</span>}
      </button>
      <button className={'task-navigation-item' + (props.activeTab === 'hosts' ? ' active' : '')} onClick={() => props.onSelect('hosts')}>
        <Icon name="laptop" />
        <span>Mac</span>
      </button>
      <div className="task-navigation-divider" />
      <button className="task-navigation-item" onClick={props.onRefresh}>
        <Icon name="refresh" />
        <span>刷新</span>
      </button>
    </div>
  )
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
  pushState: PushState
  onEnablePush: () => Promise<boolean>
  onDisablePush: () => Promise<boolean>
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
      <div className="card push-card">
        <div className="row">
          <strong>手机通知</strong>
          <span className={`status ${props.pushState === 'enabled' ? 'running' : 'idle'}`}>
            {pushStateLabel(props.pushState)}
          </span>
        </div>
        <div className="muted">审批、Agent 问题和检查完成后，Mac 会主动通知你，不需要一直打开页面。</div>
        {(props.pushState === 'disabled' || props.pushState === 'error') && (
          <button className="small" onClick={() => void props.onEnablePush()}>开启通知</button>
        )}
        {props.pushState === 'enabled' && (
          <button className="ghost small" onClick={() => void props.onDisablePush()}>关闭通知</button>
        )}
        {props.pushState === 'denied' && (
          <div className="field-error">通知权限已拒绝，请在系统设置中允许后再试。</div>
        )}
      </div>
    </section>
  )
}

function pushStateLabel(state: PushState): string {
  switch (state) {
    case 'checking': return '检查中'
    case 'unsupported': return '浏览器不支持'
    case 'unconfigured': return 'Host 未配置'
    case 'disabled': return '未开启'
    case 'enabled': return '已开启'
    case 'denied': return '权限被拒绝'
    case 'error': return '需要重试'
  }
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
  checks: CheckDefinitionSummary[]
  checkRuns: Record<string, CheckRun>
  onRunCheck: (checkId: string, sessionId?: string) => Promise<CheckRun | null>
  onCancelCheck: (runId: string) => Promise<boolean>
  previews: PreviewDefinitionSummary[]
  onOpenPreview: (previewId: string) => Promise<PreviewOpenResult | null>
  promptText: string
  setPromptText: (value: string) => void
  draftVersion: number
  clearDraftIfVersion: (version: number) => void
  onSelect: (sessionId: string | null) => void
  onNew: (workspaceId?: string) => void
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
  const [expandedProjects, setExpandedProjects] = useState<string[]>([])
  const chats = useMemo(() => sortTaskChats(props.sessions), [props.sessions])
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

  const toggleProject = (workspaceId: string) => {
    setExpandedProjects(previous => toggleTaskProject(previous, workspaceId))
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
          checks={props.checks}
          checkRuns={props.checkRuns}
          onRunCheck={props.onRunCheck}
          onCancelCheck={props.onCancelCheck}
          previews={props.previews}
          onOpenPreview={props.onOpenPreview}
          promptText={props.promptText}
          setPromptText={props.setPromptText}
          draftVersion={props.draftVersion}
          clearDraftIfVersion={props.clearDraftIfVersion}
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
    <section className="page-section task-home-page">
      <section className="task-home-section" aria-labelledby="task-home-projects">
        <h2 id="task-home-projects">项目</h2>
        <div className="task-home-project-list">
          {props.workspaces.map(workspace => {
            const expanded = expandedProjects.includes(workspace.workspaceId)
            const projectChats = taskChatsForProject(chats, workspace.workspaceId)
            return (
            <div className="task-home-project" key={workspace.workspaceId}>
              <div className="task-home-project-row">
              <button
                className="task-home-project-toggle"
                aria-expanded={expanded}
                aria-controls={'project-chats-' + workspace.workspaceId}
                onClick={() => toggleProject(workspace.workspaceId)}
              >
                <span className={'task-home-project-chevron' + (expanded ? ' expanded' : '')} aria-hidden="true">
                  <Icon name="chevron-down" />
                </span>
                <span className="task-home-project-copy">
                  <Icon name="folder" />
                  <span>{workspace.title}</span>
                </span>
              </button>
              <button
                className="task-home-row-action"
                aria-label={'在 ' + workspace.title + ' 中新建聊天'}
                onClick={() => props.onNew(workspace.workspaceId)}
              >
                <Icon name="edit" />
              </button>
              </div>
              {expanded && (
                <div className="task-home-project-chat-list" id={'project-chats-' + workspace.workspaceId}>
                  {projectChats.length === 0 && <div className="task-home-project-empty">此项目还没有聊天</div>}
                  {projectChats.map(session => (
                    <button
                      className="task-home-chat-row"
                      key={session.sessionId}
                      onClick={() => props.onSelect(session.sessionId)}
                    >
                      <span>{session.title ?? '未命名聊天'}</span>
                      {(attentionBySession.get(session.sessionId) ?? 0) > 0 && (
                        <small className="task-home-attention">需处理 {attentionBySession.get(session.sessionId)}</small>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            )
          })}
          {props.workspaces.length === 0 && (
            <div className="task-home-empty-projects">还没有项目，可以在 Mac 页面添加工作区。</div>
          )}
        </div>
      </section>

      <section className="task-home-section task-home-chats" aria-labelledby="task-home-chats">
        <div className="task-home-section-heading">
          <h2 id="task-home-chats">聊天</h2>
          <button className="task-home-heading-action" aria-label="新建聊天" onClick={() => props.onNew()}>
            <Icon name="edit" />
          </button>
        </div>
        {searchText.trim() !== '' ? (
          <div className="task-home-search-results">
            {props.searchResults.length === 0 && <div className="task-home-empty-chats">没有找到匹配的聊天</div>}
            {props.searchResults.map(result => (
              <button
                className="task-home-chat-row"
                key={result.sessionId}
                onClick={() => {
                  setSearchText('')
                  props.onSelect(result.sessionId)
                }}
              >
                <span>{sessionTitle(props.sessions, result.sessionId)}</span>
                <small>{result.snippet}</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="task-home-chat-list">
            {chats.map(session => (
              <button className="task-home-chat-row" key={session.sessionId} onClick={() => props.onSelect(session.sessionId)}>
                <span>{session.title ?? '未命名聊天'}</span>
                {(attentionBySession.get(session.sessionId) ?? 0) > 0 && (
                  <small className="task-home-attention">需处理 {attentionBySession.get(session.sessionId)}</small>
                )}
              </button>
            ))}
            {chats.length === 0 && <div className="task-home-empty-chats">还没有聊天，点击下方“聊天”开始。</div>}
          </div>
        )}
      </section>

      <WorkspaceForm onCreateWorkspace={props.onCreateWorkspace} />

      <div className="task-home-toolbar">
        <div className="search-field task-home-search">
          <Icon name="search" />
          <input
            className="search task-home-search-input"
            value={searchText}
            onChange={event => setSearchText(event.target.value)}
            placeholder="搜索聊天"
            aria-label="搜索聊天"
          />
        </div>
        <button className="task-home-chat-button" onClick={() => props.onNew()}>
          <Icon name="edit" />
          <span>聊天</span>
        </button>
      </div>
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
  checks: CheckDefinitionSummary[]
  checkRuns: Record<string, CheckRun>
  onRunCheck: (checkId: string, sessionId?: string) => Promise<CheckRun | null>
  onCancelCheck: (runId: string) => Promise<boolean>
  previews: PreviewDefinitionSummary[]
  onOpenPreview: (previewId: string) => Promise<PreviewOpenResult | null>
  promptText: string
  setPromptText: (value: string) => void
  draftVersion: number
  clearDraftIfVersion: (version: number) => void
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
  const [detailView, setDetailView] = useState<'conversation' | 'review'>('conversation')
  const [sending, setSending] = useState(false)
  const retryActionRef = useRef<{ fingerprint: string; key: string } | null>(null)
  const actionCopy = composerCopy(props.session.running, sending)

  const submit = async (mode: 'queue' | 'steer') => {
    const text = props.promptText.trim()
    if (text === '' || sending) return
    const submittedDraftVersion = props.draftVersion
    const fingerprint = `${mode}\u0000${text}`
    if (retryActionRef.current?.fingerprint !== fingerprint) {
      retryActionRef.current = { fingerprint, key: clientActionId('prompt') }
    }
    setSending(true)
    const sent = await props.onSend(text, mode, retryActionRef.current.key)
    setSending(false)
    if (sent) {
      retryActionRef.current = null
      props.clearDraftIfVersion(submittedDraftVersion)
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

      <CheckPanel
        checks={props.checks}
        checkRuns={props.checkRuns}
        sessionId={props.session.sessionId}
        onRun={props.onRunCheck}
        onCancel={props.onCancelCheck}
      />

      <PreviewPanel previews={props.previews} onOpen={props.onOpenPreview} />

      <div className="detail-segments" aria-label="任务详情视图">
        <button className="detail-segment-conversation" aria-pressed={detailView === 'conversation'} onClick={() => setDetailView('conversation')}>对话</button>
        <button className="detail-segment-review" aria-pressed={detailView === 'review'} onClick={() => setDetailView('review')}>执行记录</button>
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
              <ConversationView
                nodes={nodes}
                history={props.history}
                historyLoading={props.historyLoading}
                loadingOlder={props.loadingOlder}
                historyNotice={props.historyNotice}
                onLoadOlder={props.onLoadOlder}
                blankSession={props.session.blank}
              />

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
                    placeholder={actionCopy.placeholder}
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
                          className="ghost composer-queue"
                          aria-label="排到下一轮"
                          disabled={sending || props.promptText.trim() === ''}
                          onClick={() => void submit('queue')}
                        >
                          <span className="composer-queue-label-long">排到下一轮</span>
                          <span className="composer-queue-label-short" aria-hidden="true">排队</span>
                        </button>
                      )}
                      <button
                        className="composer-send"
                        aria-label={actionCopy.sendLabel}
                        title={actionCopy.sendLabel}
                        disabled={sending || props.promptText.trim() === ''}
                        onClick={() => void submit(actionCopy.mode)}
                      >
                        <Icon name="send" />
                        <span className="composer-send-label">{actionCopy.sendLabel}</span>
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

function CheckPanel(props: {
  checks: CheckDefinitionSummary[]
  checkRuns: Record<string, CheckRun>
  sessionId: string
  onRun: (checkId: string, sessionId?: string) => Promise<CheckRun | null>
  onCancel: (runId: string) => Promise<boolean>
}) {
  const [selectedCheckId, setSelectedCheckId] = useState(props.checks[0]?.checkId ?? '')

  useEffect(() => {
    if (props.checks.some(check => check.checkId === selectedCheckId)) return
    setSelectedCheckId(props.checks[0]?.checkId ?? '')
  }, [props.checks, selectedCheckId])

  const latestRun = Object.values(props.checkRuns)
    .filter(run => run.checkId === selectedCheckId && run.sessionId === props.sessionId)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0]
  const active = latestRun?.status === 'queued' || latestRun?.status === 'running'

  if (props.checks.length === 0) {
    return (
      <div className="check-panel card">
        <div className="row"><strong>项目检查</strong><span className="muted">未配置</span></div>
        <div className="muted">在 Mac Host 配置允许的检查命令后，手机可以在这里触发类型检查、测试或构建。</div>
      </div>
    )
  }

  return (
    <div className="check-panel card">
      <div className="row">
        <strong>项目检查</strong>
        <span className="muted">Mac 执行</span>
      </div>
      <div className="check-controls">
        <select value={selectedCheckId} onChange={event => setSelectedCheckId(event.target.value)} aria-label="选择项目检查">
          {props.checks.map(check => <option key={check.checkId} value={check.checkId}>{check.label}</option>)}
        </select>
        {active
          ? <button className="ghost small" onClick={() => void props.onCancel(latestRun?.runId ?? '')}>取消检查</button>
          : <button className="small" onClick={() => void props.onRun(selectedCheckId, props.sessionId)}>运行检查</button>}
      </div>
      {latestRun !== undefined && (
        <div className="check-result">
          <div className="row">
            <span className={`check-status ${latestRun.status}`}>{checkStatusLabel(latestRun.status)}</span>
            {latestRun.exitCode !== undefined && <span className="muted">退出码 {latestRun.exitCode}</span>}
          </div>
          {latestRun.log !== '' && <pre className="check-log">{latestRun.log}</pre>}
        </div>
      )}
    </div>
  )
}

function PreviewPanel(props: {
  previews: PreviewDefinitionSummary[]
  onOpen: (previewId: string) => Promise<PreviewOpenResult | null>
}) {
  const [selectedPreviewId, setSelectedPreviewId] = useState(props.previews[0]?.previewId ?? '')
  const [opened, setOpened] = useState<PreviewOpenResult | null>(null)
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    if (props.previews.some(preview => preview.previewId === selectedPreviewId)) return
    setSelectedPreviewId(props.previews[0]?.previewId ?? '')
    setOpened(null)
  }, [props.previews, selectedPreviewId])

  const open = async () => {
    if (selectedPreviewId === '' || opening) return
    setOpening(true)
    const result = await props.onOpen(selectedPreviewId)
    setOpening(false)
    if (result !== null) setOpened(result)
  }

  if (props.previews.length === 0) {
    return (
      <div className="preview-panel card">
        <div className="row"><strong>实时预览</strong><span className="muted">未配置</span></div>
        <div className="muted">配置一个 Mac 本机的开发服务器后，可以直接在手机里打开并手动操作。</div>
      </div>
    )
  }

  return (
    <div className="preview-panel card">
      <div className="row">
        <strong>实时预览</strong>
        <span className="muted">手机交互</span>
      </div>
      <div className="preview-controls">
        <select value={selectedPreviewId} onChange={event => setSelectedPreviewId(event.target.value)} aria-label="选择实时预览">
          {props.previews.map(preview => <option key={preview.previewId} value={preview.previewId}>{preview.label}</option>)}
        </select>
        <button className="small" disabled={opening} onClick={() => void open()}>
          {opening ? '打开中…' : opened === null ? '打开预览' : '重新打开'}
        </button>
      </div>
      {opened !== null && (
        <div className="preview-frame-wrap">
          <div className="preview-frame-head">
            <span className="muted">令牌有效至 {new Date(opened.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
            <a href={opened.url} target="_blank" rel="noreferrer">新窗口</a>
          </div>
          <iframe
            className="preview-frame"
            title={opened.label}
            src={opened.url}
            sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin"
          />
        </div>
      )}
    </div>
  )
}

function checkStatusLabel(status: CheckRun['status']): string {
  switch (status) {
    case 'queued': return '排队中'
    case 'running': return '运行中'
    case 'passed': return '通过'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    case 'interrupted': return '已中断'
  }
}

function ConversationView(props: {
  nodes: readonly ReviewNode[]
  history: SessionHistoryPage | null
  historyLoading: boolean
  loadingOlder: boolean
  historyNotice: UserFeedback | null
  onLoadOlder: () => void
  blankSession: boolean
}) {
  const items = useMemo(() => conversationNodes(props.nodes), [props.nodes])
  const firstSeq = props.history?.events[0]?.sequence

  return (
    <section className="conversation-view" aria-label="对话内容">
      {props.historyNotice !== null && <div className="review-notice"><FeedbackNotice feedback={props.historyNotice} /></div>}

      {props.history !== null && props.history.hasMore && (
        <button className="conversation-load-older ghost" disabled={props.loadingOlder} onClick={props.onLoadOlder}>
          {props.loadingOlder ? '加载中…' : `查看更早对话（从 #${firstSeq ?? 0} 开始）`}
        </button>
      )}

      {props.historyLoading && props.history === null && <div className="card loading-card">正在同步任务进度…</div>}

      {props.historyLoading === false && items.length === 0 && (
        <div className="empty-state compact">
          <strong>{props.blankSession ? '描述你要完成的工作' : '暂无可展示的消息'}</strong>
          <span>指令会在这台 Mac 上的当前安全策略下执行。</span>
        </div>
      )}

      {items.length > 0 && (
        <div className="conversation-list">
          {items.map(node => node.kind === 'message'
            ? <ConversationMessage key={`message:${node.seq}`} node={node} />
            : <ConversationTool key={`tool:${node.seq}`} node={node} />)}
        </div>
      )}
    </section>
  )
}

function ConversationMessage(props: { node: ReviewMessageNode }) {
  const node = props.node
  const [expanded, setExpanded] = useState(false)
  const preview = useMemo(() => compactConversationText(node.text), [node.text])
  const reasoningLabel = node.reasoning === undefined ? '' : compactReasoningLabel(node.reasoning)
  const label = node.role === 'user' ? '你' : node.partial === true ? 'Agent · 进行中' : 'Agent'

  return (
    <article className={`conversation-message ${node.role}${node.partial === true ? ' partial' : ''}`}>
      <div className="conversation-message-head">
        <span className={`conversation-message-role ${node.role}`}>{label}</span>
        <span className="muted">{new Date(node.timestamp).toLocaleTimeString()}</span>
        {node.text !== '' && <CopyButton value={node.text} label="复制" />}
      </div>
      {node.text !== '' && (
        <div className={`conversation-message-body${node.role === 'user' ? ' user-bubble' : ''}`}>
          {expanded ? node.text : preview.text}
        </div>
      )}
      {(preview.truncated || reasoningLabel !== '') && (
        <div className="conversation-message-meta">
          {preview.truncated && (
            <button className="conversation-expand ghost" onClick={() => setExpanded(value => !value)}>
              {expanded ? '收起' : '展开全文'}
            </button>
          )}
          {reasoningLabel !== '' && (
            <details className="conversation-reasoning">
              <summary>{reasoningLabel}</summary>
              <pre className="preview">{node.reasoning}</pre>
            </details>
          )}
        </div>
      )}
    </article>
  )
}

function ConversationTool(props: { node: Extract<ReviewNode, { kind: 'tool' }> }) {
  const node = props.node
  const statusKey = node.resultText === undefined
    ? 'running'
    : node.resultIsError === true ? 'error' : 'done'
  const status = statusKey === 'error' ? '失败' : statusKey === 'done' ? '完成' : '运行中'

  return (
    <div className={`conversation-tool status-${statusKey}`}>
      <span className="conversation-tool-mark" aria-hidden="true" />
      <span className="conversation-tool-title">{node.title}</span>
      <span className="muted">{status}</span>
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
  initialWorkspaceId?: string | undefined
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
  const [workspaceId, setWorkspaceId] = useState(props.initialWorkspaceId ?? '')
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
  approvalNotice: ReturnType<typeof useRemote>['approvalNotice']
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

      {props.approvalNotice !== null && total === 0 && (
        <div className="approval-confirmation" role="status" aria-live="polite">
          {props.approvalNotice.outcome === 'allowed-once' ? '已允许一次' : '已拒绝'} · {' '}
          {props.approvalNotice.display?.toolTitle ?? props.approvalNotice.request.toolName}
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
        const answersReady = questionAnswersReady(request, draft)
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
              className="question-submit"
              disabled={pendingAction !== null || !answersReady}
              aria-describedby={answersReady ? undefined : `question-requirement-${request.rpcId}`}
              onClick={() => void runAction(`question:${request.rpcId}`, async () => {
                const customByQuestionId = Object.fromEntries(request.questions.map(question => [
                  question.id,
                  customAnswers[`${request.rpcId}:${question.id}`] ?? '',
                ]))
                const answers = questionAnswersForSubmit(request, draft, customByQuestionId)
                props.onUpdateDraft(request.rpcId, answers)
                return props.onAnswer(request, answers)
              })}
            >
              {busy ? '提交中…' : '提交回答'}
            </button>
            {!answersReady && (
              <div className="question-requirement" id={`question-requirement-${request.rpcId}`} role="status">
                问题尚未完整加载，请刷新后重试。
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
  const reviewRootRef = useRef<HTMLElement>(null)
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

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const root = reviewRootRef.current
      const scroller = root?.closest('main')
      if (scroller instanceof HTMLElement) scroller.scrollTop = 0
      else root?.scrollIntoView({ block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [props.sessionId])

  return (
    <section className="review-view" ref={reviewRootRef}>
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

      <div className="timeline">
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
