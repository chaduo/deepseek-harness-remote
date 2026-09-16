import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_LOG_BYTES = 256 * 1024

export type CheckStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted'

export interface CheckDefinition {
  checkId: string
  label: string
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
}

export interface CheckRun {
  runId: string
  checkId: string
  sessionId?: string
  status: CheckStatus
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  log: string
  workspaceFingerprint: string
}

export interface CheckRunnerEvent {
  type: 'check.started' | 'check.output' | 'check.finished'
  run: CheckRun
  chunk?: string
}

type SpawnOptions = {
  cwd: string
  stdio: ['ignore', 'pipe', 'pipe']
}

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcessByStdio<null, Readable, Readable>

export interface CheckRunnerOptions {
  definitions: readonly CheckDefinition[]
  spawn?: SpawnProcess
  now?: () => number
  newId?: () => string
}

export async function loadCheckDefinitions(filePath?: string): Promise<CheckDefinition[]> {
  if (filePath === undefined) return []
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('check definition file must contain an array')
  return parsed.map((value, index) => {
    if (typeof value !== 'object' || value === null) throw new Error(`check definition ${index} is not an object`)
    const item = value as Record<string, unknown>
    const checkId = typeof item.checkId === 'string' ? item.checkId.trim() : ''
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    const command = typeof item.command === 'string' ? item.command.trim() : ''
    const args = Array.isArray(item.args) && item.args.every(arg => typeof arg === 'string')
      ? item.args as string[]
      : []
    const cwd = typeof item.cwd === 'string' ? item.cwd.trim() : ''
    const timeoutMs = typeof item.timeoutMs === 'number' ? item.timeoutMs : 0
    if (checkId === '' || label === '' || command === '' || cwd === '' || timeoutMs < 1 || !Number.isInteger(timeoutMs)) {
      throw new Error(`invalid check definition at index ${index}`)
    }
    return { checkId, label, command, args, cwd, timeoutMs }
  })
}

interface InternalRun {
  run: CheckRun
  definition: CheckDefinition
  process?: ChildProcessByStdio<null, Readable, Readable>
  cancelRequested: boolean
  shutdownRequested: boolean
  timeoutTriggered: boolean
  waiters: Array<(run: CheckRun) => void>
}

export class CheckRunner {
  private readonly definitions: Map<string, CheckDefinition>
  private readonly spawnProcess: SpawnProcess
  private readonly now: () => number
  private readonly newId: () => string
  private readonly runs = new Map<string, InternalRun>()
  private readonly listeners = new Set<(event: CheckRunnerEvent) => void>()
  private closed = false

  constructor(options: CheckRunnerOptions) {
    this.definitions = new Map(options.definitions.map(definition => [definition.checkId, {
      ...definition,
      args: [...definition.args],
    }]))
    this.spawnProcess = options.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions))
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => crypto.randomUUID())
  }

  listDefinitions(): CheckDefinition[] {
    return [...this.definitions.values()].map(definition => ({ ...definition, args: [...definition.args] }))
  }

  onEvent(listener: (event: CheckRunnerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(checkId: string, sessionId?: string): CheckRun {
    if (this.closed) throw new Error('check runner is closed')
    const definition = this.definitions.get(checkId)
    if (definition === undefined) throw new Error(`unknown check: ${checkId}`)

    for (const current of this.runs.values()) {
      if (
        current.definition.cwd === definition.cwd
        && (current.run.status === 'queued' || current.run.status === 'running')
      ) {
        throw new Error(`a check is already running for ${definition.cwd}`)
      }
    }

    const run: CheckRun = {
      runId: this.newId(),
      checkId,
      ...(sessionId !== undefined && { sessionId }),
      status: 'queued',
      log: '',
      workspaceFingerprint: '',
    }
    const internal: InternalRun = {
      run,
      definition,
      cancelRequested: false,
      shutdownRequested: false,
      timeoutTriggered: false,
      waiters: [],
    }
    this.runs.set(run.runId, internal)
    void this.execute(internal)
    return this.copy(run)
  }

  get(runId: string): CheckRun | undefined {
    const internal = this.runs.get(runId)
    return internal === undefined ? undefined : this.copy(internal.run)
  }

  cancel(runId: string): { accepted: boolean } {
    const internal = this.runs.get(runId)
    if (internal === undefined) return { accepted: false }
    if (internal.run.status !== 'queued' && internal.run.status !== 'running') return { accepted: false }
    internal.cancelRequested = true
    if (internal.process !== undefined) {
      this.terminate(internal.process)
    }
    return { accepted: true }
  }

  async wait(runId: string): Promise<CheckRun> {
    const internal = this.runs.get(runId)
    if (internal === undefined) throw new Error(`unknown check run: ${runId}`)
    if (this.isTerminal(internal.run.status)) return this.copy(internal.run)
    return new Promise(resolve => internal.waiters.push(resolve))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const waits: Promise<CheckRun>[] = []
    for (const internal of this.runs.values()) {
      if (this.isTerminal(internal.run.status)) continue
      internal.shutdownRequested = true
      if (internal.process !== undefined) this.terminate(internal.process)
      waits.push(this.wait(internal.run.runId))
    }
    await Promise.all(waits)
  }

  private async execute(internal: InternalRun): Promise<void> {
    const { run, definition } = internal
    try {
      run.workspaceFingerprint = await fingerprintWorkspace(definition.cwd)
      if (this.closed || internal.shutdownRequested) {
        this.finish(internal, 'interrupted')
        return
      }
      if (internal.cancelRequested) {
        this.finish(internal, 'cancelled')
        return
      }

      run.status = 'running'
      run.startedAt = new Date(this.now()).toISOString()
      this.emit({ type: 'check.started', run: this.copy(run) })

      const child = this.spawnProcess(definition.command, definition.args, {
        cwd: definition.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      internal.process = child
      const timer = setTimeout(() => {
        internal.timeoutTriggered = true
        this.appendLog(internal, `\ncheck timed out after ${definition.timeoutMs}ms\n`)
        this.terminate(child)
      }, definition.timeoutMs)

      const output = (chunk: Buffer | string) => {
        const text = String(chunk)
        this.appendLog(internal, text)
        this.emit({ type: 'check.output', run: this.copy(run), chunk: text })
      }
      child.stdout.on('data', output)
      child.stderr.on('data', output)

      await new Promise<void>(resolve => {
        let settled = false
        const settle = (status: CheckStatus, exitCode?: number) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (exitCode !== undefined) run.exitCode = exitCode
          this.finish(internal, status)
          resolve()
        }
        child.once('error', error => {
          this.appendLog(internal, `\n${error instanceof Error ? error.message : String(error)}\n`)
          settle(internal.shutdownRequested ? 'interrupted' : internal.cancelRequested ? 'cancelled' : 'failed')
        })
        child.once('close', (code: number | null) => {
          if (internal.shutdownRequested) settle('interrupted', code ?? undefined)
          else if (internal.cancelRequested) settle('cancelled', code ?? undefined)
          else if (internal.timeoutTriggered) settle('failed', code ?? undefined)
          else settle(code === 0 ? 'passed' : 'failed', code ?? undefined)
        })
      })
    } catch (error) {
      this.appendLog(internal, `\n${error instanceof Error ? error.message : String(error)}\n`)
      this.finish(internal, internal.shutdownRequested ? 'interrupted' : 'failed')
    }
  }

  private finish(internal: InternalRun, status: CheckStatus): void {
    if (this.isTerminal(internal.run.status)) return
    internal.run.status = status
    internal.run.finishedAt = new Date(this.now()).toISOString()
    this.emit({ type: 'check.finished', run: this.copy(internal.run) })
    const result = this.copy(internal.run)
    for (const resolve of internal.waiters.splice(0)) resolve(result)
  }

  private appendLog(internal: InternalRun, chunk: string): void {
    const next = `${internal.run.log}${chunk}`
    internal.run.log = next.length <= MAX_LOG_BYTES
      ? next
      : `${next.slice(0, MAX_LOG_BYTES)}\n[log truncated]\n`
  }

  private terminate(child: ChildProcessByStdio<null, Readable, Readable>): void {
    if (!child.killed) child.kill('SIGTERM')
  }

  private emit(event: CheckRunnerEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private isTerminal(status: CheckStatus): boolean {
    return status === 'passed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
  }

  private copy(run: CheckRun): CheckRun {
    return { ...run }
  }
}

async function fingerprintWorkspace(cwd: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(cwd)
  try {
    const { stdout: head } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD'])
    hash.update(head)
    const { stdout: diff } = await execFileAsync('git', ['-C', cwd, 'diff', '--no-ext-diff', '--binary'])
    hash.update(diff)
    const { stdout: untracked } = await execFileAsync('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z'])
    const paths = untracked.split('\0').filter(Boolean)
    for (const relativePath of paths) {
      hash.update(relativePath)
      try {
        hash.update(await readFile(`${cwd}/${relativePath}`))
      } catch {
        hash.update('[unreadable]')
      }
    }
  } catch {
    hash.update('[no-git-metadata]')
  }
  return hash.digest('hex')
}
