import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeepSeekHarnessAdapter } from '@dsh-remote/adapter-deepseek'
import { PreviewProxy } from '../src/preview-proxy.js'
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

function body(method: string, payload: unknown): string {
  return JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), method, payload })
}

async function rpc(port: number, method: string, payload: unknown): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/remote/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
    },
    body: body(method, payload),
  })
  expect(response.status).toBe(200)
  return await response.json() as Record<string, any>
}

describe('RemoteHostServer previews', () => {
  let server: RemoteHostServer | undefined
  let target: Server | undefined

  afterEach(async () => {
    await server?.close()
    await new Promise<void>(resolve => {
      if (target === undefined) return resolve()
      target.close(() => resolve())
      target = undefined
    })
  })

  it('opens a protected local web app and proxies a real form request', async () => {
    target = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/submit') {
        const chunks: Buffer[] = []
        request.on('data', chunk => chunks.push(chunk))
        request.on('end', () => response.end(Buffer.concat(chunks)))
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<main>preview</main><form action="/api/submit" method="post"></form>')
    })
    await new Promise<void>(resolve => target?.listen(0, '127.0.0.1', () => resolve()))
    const address = target.address()
    if (address === null || typeof address === 'string') throw new Error('target did not start')

    const previewProxy = new PreviewProxy({
      definitions: [{ previewId: 'web-app', label: 'Web app', origin: `http://127.0.0.1:${address.port}` }],
      secret: 'server-preview-secret',
    })
    server = new RemoteHostServer({
      hostId: 'host_1',
      adapter: adapter(),
      logger,
      port: 0,
      previewProxy,
    })
    const port = await server.start()

    const listed = await rpc(port, 'preview.list', {})
    expect(listed.result.value.items).toEqual([{ previewId: 'web-app', label: 'Web app' }])
    const opened = await rpc(port, 'preview.open', { previewId: 'web-app' })
    const previewUrl = new URL(opened.result.value.url, `http://127.0.0.1:${port}`)

    const missingToken = await fetch(new URL(`${previewUrl.pathname}`, previewUrl), {
      headers: { origin: `http://127.0.0.1:${port}` },
    })
    expect(missingToken.status).toBe(403)

    const page = await fetch(previewUrl, {
      headers: { origin: `http://127.0.0.1:${port}` },
    })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('/api/preview/web-app/api/submit?token=')

    const formUrl = new URL(`/api/preview/web-app/api/submit?${previewUrl.searchParams.toString()}`, previewUrl)
    const submitted = await fetch(formUrl, {
      method: 'POST',
      headers: {
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'text/plain',
      },
      body: 'from-phone',
    })
    expect(submitted.status).toBe(200)
    expect(await submitted.text()).toBe('from-phone')
  })
})
