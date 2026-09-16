import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemotePrincipal } from '@dsh-remote/protocol'
import {
  PreviewProxy,
  loadPreviewDefinitions,
  type PreviewDefinition,
} from '../src/preview-proxy.js'

const principal: RemotePrincipal = {
  userId: 'user_1',
  deviceId: 'phone_1',
  hostId: 'host_1',
  roles: ['owner'],
}

const definition: PreviewDefinition = {
  previewId: 'web-app',
  label: 'Web app',
  origin: 'http://127.0.0.1:4173',
}

function tokenFrom(url: string): string {
  const token = new URL(`http://remote.local${url}`).searchParams.get('token')
  if (token === null) throw new Error('preview URL did not include a token')
  return token
}

function requestInput(token: string, overrides: Partial<Parameters<PreviewProxy['request']>[0]> = {}) {
  return {
    previewId: 'web-app',
    pathname: '/',
    search: `?token=${encodeURIComponent(token)}`,
    token,
    principal,
    method: 'GET',
    headers: new Headers(),
    ...overrides,
  }
}

describe('PreviewProxy', () => {
  let target: Server | undefined

  afterEach(async () => {
    await new Promise<void>(resolve => {
      if (target === undefined) return resolve()
      target.close(() => resolve())
      target = undefined
    })
  })

  it('loads loopback-only definitions and issues device-bound URLs', async () => {
    const proxy = new PreviewProxy({
      definitions: [definition],
      secret: 'test-secret-for-preview',
      now: () => 1_700_000_000_000,
      tokenTtlMs: 60_000,
    })

    expect(proxy.listDefinitions()).toEqual([{ previewId: 'web-app', label: 'Web app' }])
    const opened = proxy.open('web-app', principal)
    expect(opened.url).toMatch(/^\/api\/preview\/web-app\/?\?token=/)
    expect(opened.expiresAt).toBe(1_700_000_060_000)

    await expect(proxy.request(requestInput(tokenFrom(opened.url), {
      principal: { ...principal, deviceId: 'other-device' },
    }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('proxies HTML and forwards interactive requests without exposing the target origin', async () => {
    target = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/submit') {
        const chunks: Buffer[] = []
        request.on('data', chunk => chunks.push(chunk))
        request.on('end', () => {
          response.setHeader('content-type', 'application/json')
          response.end(Buffer.concat(chunks))
        })
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<script src="/assets/app.js"></script><form action="/api/submit"></form>')
    })
    await new Promise<void>(resolve => target?.listen(0, '127.0.0.1', () => resolve()))
    const address = target.address()
    if (address === null || typeof address === 'string') throw new Error('target did not start')

    const proxy = new PreviewProxy({
      definitions: [{ ...definition, origin: `http://127.0.0.1:${address.port}` }],
      secret: 'test-secret-for-preview',
    })
    const opened = proxy.open('web-app', principal)
    const token = tokenFrom(opened.url)

    const page = await proxy.request(requestInput(token))
    const html = new TextDecoder().decode(page.body)
    expect(page.status).toBe(200)
    expect(html).toContain('/api/preview/web-app/assets/app.js?token=')
    expect(html).not.toContain(`127.0.0.1:${address.port}`)

    const submitted = await proxy.request(requestInput(token, {
      pathname: '/api/submit',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"ok":true}'),
    }))
    expect(submitted.status).toBe(200)
    expect(new TextDecoder().decode(submitted.body)).toBe('{"ok":true}')
  })

  it('rejects expired tokens and non-loopback preview origins', () => {
    expect(() => new PreviewProxy({
      definitions: [{ ...definition, origin: 'http://example.com' }],
      secret: 'test-secret-for-preview',
    })).toThrow('loopback')

    const proxy = new PreviewProxy({
      definitions: [definition],
      secret: 'test-secret-for-preview',
      now: () => 2_000,
      tokenTtlMs: 1_000,
    })
    const opened = proxy.open('web-app', principal)
    const expired = new PreviewProxy({
      definitions: [definition],
      secret: 'test-secret-for-preview',
      now: () => 3_001,
      tokenTtlMs: 1_000,
    })
    return expect(expired.request(requestInput(tokenFrom(opened.url)))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('does not allow a preview path to replace the configured origin', async () => {
    const proxy = new PreviewProxy({ definitions: [definition], secret: 'test-secret-for-preview' })
    const opened = proxy.open('web-app', principal)
    await expect(proxy.request(requestInput(tokenFrom(opened.url), { pathname: '//attacker.example' })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('validates JSON definition files', async () => {
    await expect(loadPreviewDefinitions()).resolves.toEqual([])
    await expect(loadPreviewDefinitions('/path/that/does/not/exist')).rejects.toThrow()
  })
})
