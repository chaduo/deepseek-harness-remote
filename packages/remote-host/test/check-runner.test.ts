import { afterEach, describe, expect, it } from 'vitest'
import { CheckRunner, type CheckDefinition } from '../src/check-runner.js'

const cwd = process.cwd()
const node = process.execPath

const definitions: CheckDefinition[] = [
  {
    checkId: 'pass',
    label: 'Pass',
    command: node,
    args: ['-e', 'process.stdout.write("ok")'],
    cwd,
    timeoutMs: 1_000,
  },
  {
    checkId: 'fail',
    label: 'Fail',
    command: node,
    args: ['-e', 'process.stderr.write("bad"); process.exitCode = 3'],
    cwd,
    timeoutMs: 1_000,
  },
  {
    checkId: 'cancel',
    label: 'Cancel',
    command: node,
    args: ['-e', 'setTimeout(() => {}, 10_000)'],
    cwd,
    timeoutMs: 10_000,
  },
  {
    checkId: 'timeout',
    label: 'Timeout',
    command: node,
    args: ['-e', 'setTimeout(() => {}, 10_000)'],
    cwd,
    timeoutMs: 25,
  },
]

describe('CheckRunner', () => {
  let runner: CheckRunner | undefined

  afterEach(async () => {
    await runner?.close()
  })

  it('records a zero exit as passed with captured output', async () => {
    runner = new CheckRunner({ definitions })

    const started = runner.start('pass', 'session-a')
    const result = await runner.wait(started.runId)

    expect(result.status).toBe('passed')
    expect(result.exitCode).toBe(0)
    expect(result.log).toContain('ok')
    expect(result.workspaceFingerprint).not.toBe('')
  })

  it('records a non-zero exit as failed', async () => {
    runner = new CheckRunner({ definitions })

    const started = runner.start('fail')
    const result = await runner.wait(started.runId)

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(3)
    expect(result.log).toContain('bad')
  })

  it('kills an active process when cancelled', async () => {
    runner = new CheckRunner({ definitions })

    const started = runner.start('cancel')
    expect(runner.cancel(started.runId).accepted).toBe(true)
    const result = await runner.wait(started.runId)

    expect(result.status).toBe('cancelled')
  })

  it('marks a run failed when it exceeds its timeout', async () => {
    runner = new CheckRunner({ definitions })

    const started = runner.start('timeout')
    const result = await runner.wait(started.runId)

    expect(result.status).toBe('failed')
    expect(result.log).toContain('timed out')
  })
})
