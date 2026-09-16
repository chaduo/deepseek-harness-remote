import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeepSeekHarnessAdapter } from '@dsh-remote/adapter-deepseek'
import { CheckRunner } from '../src/check-runner.js'
import type { StructuredLogger } from '../src/logger.js'
import { RemoteHostServer } from '../src/server.js'

const logger: StructuredLogger = { info: () => {}, warn: () => {}, error: () => {} }

function adapter(): DeepSeekHarnessAdapter {
  return {
    hostDescribe: async () => ({
      hostId: 'host_1',
      version: '0.1.0',
      cwd: process.cwd(),
      attachedSessions: 0,
      principalUserId: '',
      principalDeviceId: '',
    }),
    close: () => {},
  } as unknown as DeepSeekHarnessAdapter
}

function body(method: string, payload: unknown, idempotencyKey?: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: randomUUID(),
    method,
    payload,
    ...(idempotencyKey !== undefined && { idempotencyKey }),
  })
}

async function rpc(port: number, method: string, payload: unknown, idempotencyKey?: string): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/remote/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
    },
    body: body(method, payload, idempotencyKey),
  })
  expect(response.status).toBe(200)
  return await response.json() as Record<string, any>
}

describe('RemoteHostServer checks', () => {
  let server: RemoteHostServer | undefined

  afterEach(async () => {
    await server?.close()
  })

  it('lists allowlisted checks and returns terminal results', async () => {
    const runner = new CheckRunner({
      definitions: [{
        checkId: 'smoke',
        label: 'Smoke test',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("mobile-check-ok")'],
        cwd: process.cwd(),
        timeoutMs: 1_000,
      }],
    })
    server = new RemoteHostServer({ hostId: 'host_1', adapter: adapter(), logger, port: 0, checkRunner: runner })
    const port = await server.start()

    const list = await rpc(port, 'check.list', {})
    expect(list.result.value.items).toEqual([{ checkId: 'smoke', label: 'Smoke test', timeoutMs: 1_000 }])

    const started = await rpc(port, 'check.run', { checkId: 'smoke', sessionId: 'session-a' }, 'run-once')
    const duplicate = await rpc(port, 'check.run', { checkId: 'smoke', sessionId: 'session-a' }, 'run-once')
    expect(started.result.value.runId).toBe(duplicate.result.value.runId)

    let current = await rpc(port, 'check.get', { runId: started.result.value.runId })
    for (
      let attempt = 0;
      attempt < 20 && (current.result.value.status === 'queued' || current.result.value.status === 'running');
      attempt += 1
    ) {
      await new Promise(resolve => setTimeout(resolve, 20))
      current = await rpc(port, 'check.get', { runId: started.result.value.runId })
    }
    expect(current.result.value.status).toBe('passed')
    expect(current.result.value.log).toContain('mobile-check-ok')
  })

  it('rejects a check id that is not configured', async () => {
    const runner = new CheckRunner({ definitions: [] })
    server = new RemoteHostServer({ hostId: 'host_1', adapter: adapter(), logger, port: 0, checkRunner: runner })
    const port = await server.start()

    const response = await rpc(port, 'check.run', { checkId: 'arbitrary-shell' }, 'blocked')

    expect(response.result.ok).toBe(false)
    expect(response.result.error.message).toContain('unknown check')
  })
})
