import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import type { DeepSeekHarnessAdapter } from '@dsh-remote/adapter-deepseek'
import type { StructuredLogger } from '../src/logger.js'
import { RemoteHostServer } from '../src/server.js'
import type { TailscaleIdentityProvider } from '../src/tailscale-identity.js'

const logger: StructuredLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

function adapterWith(overrides: Partial<DeepSeekHarnessAdapter> = {}): DeepSeekHarnessAdapter {
  return {
    hostDescribe: async () => ({
      hostId: 'host_1',
      version: '0.0.1',
      cwd: '/tmp',
      attachedSessions: 0,
      principalUserId: '',
      principalDeviceId: '',
    }),
    close: () => {},
    ...overrides,
  } as unknown as DeepSeekHarnessAdapter
}

function identityProvider(): TailscaleIdentityProvider {
  return {
    resolve: async ip => ip === '100.102.161.14'
      ? {
          deviceId: 'device_phone',
          deviceName: 'test-phone',
          userId: 'user_1',
          tailscaleIp: ip,
          online: true,
        }
      : undefined,
  }
}

async function startServer(
  adapter: DeepSeekHarnessAdapter,
  provider?: TailscaleIdentityProvider,
): Promise<{ server: RemoteHostServer; port: number }> {
  const server = new RemoteHostServer({
    hostId: 'host_1',
    adapter,
    logger,
    port: 0,
    ...(provider !== undefined && { identityProvider: provider }),
  })
  const port = await server.start()
  return { server, port }
}

function rpcBody(method: string, payload: unknown, idempotencyKey?: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: randomUUID(),
    method,
    payload,
    ...(idempotencyKey !== undefined && { idempotencyKey }),
  })
}

async function fetchRpc(
  port: number,
  method: string,
  payload: unknown,
  options: { contentType?: string; origin?: string; idempotencyKey?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json',
  }
  if (options.origin !== undefined) headers.origin = options.origin
  const response = await fetch(`http://127.0.0.1:${port}/api/remote/${method}`, {
    method: 'POST',
    headers,
    body: rpcBody(method, payload, options.idempotencyKey),
  })
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  }
}

function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let response = ''
    socket.on('connect', () => socket.write(request))
    socket.on('data', chunk => { response += chunk })
    socket.on('end', () => resolve(response))
    socket.on('error', reject)
  })
}

function decodeChunked(response: string): string {
  const headerEnd = response.indexOf('\r\n\r\n')
  if (headerEnd === -1) return ''
  const body = response.slice(headerEnd + 4)
  if (!/^[0-9a-f]+\r\n/i.test(body)) return body
  let decoded = ''
  let cursor = 0
  while (cursor < body.length) {
    const lineEnd = body.indexOf('\r\n', cursor)
    if (lineEnd === -1) break
    const sizeText = body.slice(cursor, lineEnd).split(';')[0] ?? ''
    const size = Number.parseInt(sizeText, 16)
    if (Number.isNaN(size) || size === 0) break
    decoded += body.slice(lineEnd + 2, lineEnd + 2 + size)
    cursor = lineEnd + 2 + size + 2
  }
  return decoded
}

async function proxyRpc(
  port: number,
  method: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const body = rpcBody(method, payload, idempotencyKey)
  const response = await rawRequest(port, [
    'PROXY TCP4 100.102.161.14 127.0.0.1 54321 3090',
    `POST /api/remote/${method} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n'))
  return JSON.parse(decodeChunked(response)) as Record<string, unknown>
}

describe('RemoteHostServer request security', () => {
  it('rejects cross-origin WebSocket handshakes', async () => {
    const { server, port } = await startServer(adapterWith())
    try {
      const response = await rawRequest(port, [
        'GET /api/remote/events.mux HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Origin: https://attacker.example',
        '',
        '',
      ].join('\r\n'))

      expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden/)
    } finally {
      await server.close()
    }
  })

  it('requires JSON and rejects cross-origin RPCs', async () => {
    const { server, port } = await startServer(adapterWith())
    try {
      const crossOrigin = await fetchRpc(port, 'host.describe', {}, {
        origin: 'https://attacker.example',
      })
      expect(crossOrigin.status).toBe(403)

      const wrongType = await fetchRpc(port, 'host.describe', {}, {
        contentType: 'text/plain',
        origin: `http://127.0.0.1:${port}`,
      })
      expect(wrongType.status).toBe(415)

      const sameOrigin = await fetchRpc(port, 'host.describe', {}, {
        origin: `http://127.0.0.1:${port}`,
      })
      expect(sameOrigin.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('coalesces concurrent write RPCs with the same scoped key', async () => {
    let calls = 0
    const adapter = adapterWith({
      sessionCreate: async () => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 30))
        return `session_${calls}`
      },
    })
    const { server, port } = await startServer(adapter)
    try {
      const [first, duplicate] = await Promise.all([
        fetchRpc(port, 'session.create', {}, { idempotencyKey: 'same-key' }),
        fetchRpc(port, 'session.create', {}, { idempotencyKey: 'same-key' }),
      ])

      expect(calls).toBe(1)
      expect(first.body.result).toEqual(duplicate.body.result)
    } finally {
      await server.close()
    }
  })

  it('scopes idempotency keys by method and principal', async () => {
    let sessionCalls = 0
    let workspaceCalls = 0
    const adapter = adapterWith({
      sessionCreate: async () => {
        sessionCalls += 1
        return `session_${sessionCalls}`
      },
      workspaceCreate: async input => {
        workspaceCalls += 1
        return {
          created: true,
          workspace: {
            workspaceId: `workspace_${workspaceCalls}`,
            path: input.path,
            title: input.path,
            sessionIds: [],
            createdAt: '',
            updatedAt: '',
          },
        }
      },
    })
    const { server, port } = await startServer(adapter, identityProvider())
    try {
      await fetchRpc(port, 'session.create', {}, { idempotencyKey: 'shared-key' })
      await proxyRpc(port, 'session.create', {}, 'shared-key')
      const workspace = await fetchRpc(port, 'workspace.create', { path: '/tmp/project' }, {
        idempotencyKey: 'shared-key',
      })

      expect(sessionCalls).toBe(2)
      expect(workspaceCalls).toBe(1)
      expect(workspace.body).toMatchObject({
        result: { ok: true, value: { workspace: { workspaceId: 'workspace_1' } } },
      })
    } finally {
      await server.close()
    }
  })
})
