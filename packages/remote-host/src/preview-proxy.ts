import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { RemotePrincipal } from '@dsh-remote/protocol'

const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000
const MAX_PREVIEW_BODY_BYTES = 8 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export interface PreviewDefinition {
  previewId: string
  label: string
  /** The local dev server origin. Only loopback origins are accepted. */
  origin: string
}

export interface PreviewDefinitionSummary {
  previewId: string
  label: string
}

export interface PreviewOpenResult {
  previewId: string
  label: string
  url: string
  expiresAt: number
}

export interface PreviewProxyRequest {
  previewId: string
  pathname: string
  search: string
  token: string
  principal: RemotePrincipal
  method: string
  headers: Headers
  body?: Uint8Array
}

export interface PreviewProxyResponse {
  status: number
  headers: Headers
  body: Uint8Array
}

export interface PreviewProxyOptions {
  definitions: readonly PreviewDefinition[]
  secret: string | Uint8Array
  fetch?: typeof fetch
  now?: () => number
  tokenTtlMs?: number
  maxBodyBytes?: number
}

export class PreviewProxyError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 413 | 502,
    message: string,
  ) {
    super(message)
    this.name = 'PreviewProxyError'
  }
}

interface PreviewTokenPayload {
  previewId: string
  userId: string
  deviceId: string
  expiresAt: number
  nonce: string
}

export async function loadPreviewDefinitions(filePath?: string): Promise<PreviewDefinition[]> {
  if (filePath === undefined) return []
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('preview definition file must contain an array')
  return parsed.map((value, index) => {
    if (typeof value !== 'object' || value === null) throw new Error(`preview definition ${index} is not an object`)
    const item = value as Record<string, unknown>
    const previewId = typeof item.previewId === 'string' ? item.previewId.trim() : ''
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    const origin = typeof item.origin === 'string' ? item.origin.trim() : ''
    if (previewId === '' || label === '' || origin === '') {
      throw new Error(`invalid preview definition at index ${index}`)
    }
    validateDefinition({ previewId, label, origin })
    return { previewId, label, origin }
  })
}

export class PreviewProxy {
  private readonly definitions: Map<string, PreviewDefinition>
  private readonly secret: Uint8Array
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly tokenTtlMs: number
  private readonly maxBodyBytes: number

  constructor(options: PreviewProxyOptions) {
    this.definitions = new Map()
    for (const definition of options.definitions) {
      validateDefinition(definition)
      if (this.definitions.has(definition.previewId)) {
        throw new Error(`duplicate preview id: ${definition.previewId}`)
      }
      this.definitions.set(definition.previewId, {
        ...definition,
      })
    }
    this.secret = typeof options.secret === 'string'
      ? new TextEncoder().encode(options.secret)
      : new Uint8Array(options.secret)
    if (this.secret.length < 16) throw new Error('preview secret must contain at least 16 bytes')
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = options.now ?? Date.now
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_PREVIEW_BODY_BYTES
    if (!Number.isInteger(this.tokenTtlMs) || this.tokenTtlMs < 1_000) {
      throw new Error('preview token TTL must be at least 1000ms')
    }
  }

  listDefinitions(): PreviewDefinitionSummary[] {
    return [...this.definitions.values()].map(definition => ({
      previewId: definition.previewId,
      label: definition.label,
    }))
  }

  open(previewId: string, principal: RemotePrincipal): PreviewOpenResult {
    const definition = this.requireDefinition(previewId)
    const expiresAt = this.now() + this.tokenTtlMs
    const token = this.sign({
      previewId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      expiresAt,
      nonce: randomBytes(12).toString('base64url'),
    })
    return {
      previewId,
      label: definition.label,
      url: `/api/preview/${encodeURIComponent(previewId)}/?token=${encodeURIComponent(token)}`,
      expiresAt,
    }
  }

  async request(input: PreviewProxyRequest): Promise<PreviewProxyResponse> {
    const definition = this.requireDefinition(input.previewId)
    this.verify(input.token, input.previewId, input.principal)
    if (input.body !== undefined && input.body.byteLength > this.maxBodyBytes) {
      throw new PreviewProxyError(413, 'preview request body too large')
    }

    const targetUrl = this.targetUrl(definition, input.pathname, input.search)
    const headers = new Headers(input.headers)
    for (const name of ['connection', 'content-length', 'host', 'origin', 'referer', 'transfer-encoding']) {
      headers.delete(name)
    }
    // Let undici negotiate a response that can be forwarded without having to
    // decode and then reconstruct gzip/br content ourselves.
    headers.delete('accept-encoding')

    let response: Response
    try {
      const requestInit: RequestInit = {
        method: input.method,
        headers,
        redirect: 'manual',
      }
      if (input.body !== undefined) requestInit.body = Buffer.from(input.body) as unknown as NonNullable<RequestInit['body']>
      response = await this.fetchImpl(targetUrl.toString(), requestInit)
    } catch (error) {
      throw new PreviewProxyError(502, `preview target is unavailable: ${String(error)}`)
    }

    const responseHeaders = new Headers()
    for (const [name, value] of response.headers) {
      if (shouldDropResponseHeader(name)) continue
      responseHeaders.set(name, value)
    }

    const body = new Uint8Array(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') ?? ''
    const token = input.token
    let outputBody = body
    if (contentType.toLowerCase().includes('text/html')) {
      const html = new TextDecoder().decode(body)
      outputBody = new TextEncoder().encode(rewriteHtml(html, input.previewId, token))
    }

    const location = response.headers.get('location')
    if (location !== null) {
      responseHeaders.set('location', this.rewriteLocation(location, targetUrl, input.previewId, token))
    }
    responseHeaders.set('cache-control', 'no-store')
    responseHeaders.delete('content-length')
    responseHeaders.set('content-length', String(outputBody.byteLength))
    return {
      status: response.status,
      headers: responseHeaders,
      body: outputBody,
    }
  }

  private requireDefinition(previewId: string): PreviewDefinition {
    const definition = this.definitions.get(previewId)
    if (definition === undefined) throw new PreviewProxyError(404, `unknown preview: ${previewId}`)
    return definition
  }

  private sign(payload: PreviewTokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url')
    return `${encoded}.${signature}`
  }

  private verify(token: string, previewId: string, principal: RemotePrincipal): void {
    const [encoded, signature] = token.split('.', 2)
    if (encoded === undefined || signature === undefined) {
      throw new PreviewProxyError(403, 'invalid preview token')
    }
    const expected = createHmac('sha256', this.secret).update(encoded).digest()
    let supplied: Buffer
    try {
      supplied = Buffer.from(signature, 'base64url')
    } catch {
      throw new PreviewProxyError(403, 'invalid preview token')
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new PreviewProxyError(403, 'invalid preview token')
    }
    let payload: PreviewTokenPayload
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PreviewTokenPayload
    } catch {
      throw new PreviewProxyError(403, 'invalid preview token')
    }
    if (
      payload.previewId !== previewId
      || payload.userId !== principal.userId
      || payload.deviceId !== principal.deviceId
      || !Number.isInteger(payload.expiresAt)
      || payload.expiresAt <= this.now()
    ) {
      throw new PreviewProxyError(403, 'preview token is expired or bound to another device')
    }
  }

  private targetUrl(definition: PreviewDefinition, pathname: string, search: string): URL {
    if (!pathname.startsWith('/') || pathname.startsWith('//')) {
      throw new PreviewProxyError(400, 'preview path is not valid')
    }
    const target = new URL(pathname === '' ? '/' : pathname, definition.origin)
    const origin = new URL(definition.origin)
    if (target.origin !== origin.origin) throw new PreviewProxyError(400, 'preview path escapes target origin')
    const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    query.delete('token')
    target.search = query.toString()
    return target
  }

  private rewriteLocation(location: string, targetUrl: URL, previewId: string, token: string): string {
    let resolved: URL
    try {
      resolved = new URL(location, targetUrl)
    } catch {
      return location
    }
    if (resolved.origin !== targetUrl.origin) return location
    return previewPath(previewId, resolved.pathname, resolved.search, token)
  }
}

function validateDefinition(definition: PreviewDefinition): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(definition.previewId)) {
    throw new Error(`invalid preview id: ${definition.previewId}`)
  }
  let origin: URL
  try {
    origin = new URL(definition.origin)
  } catch {
    throw new Error(`invalid preview origin: ${definition.origin}`)
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error('preview origin must use http or https')
  }
  if (origin.username !== '' || origin.password !== '' || !LOOPBACK_HOSTS.has(origin.hostname)) {
    throw new Error('preview origin must point to a loopback host')
  }
  if (origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    throw new Error('preview origin must contain only a scheme, host, and port')
  }
}

function shouldDropResponseHeader(name: string): boolean {
  return new Set([
    'connection',
    'content-encoding',
    'content-length',
    'content-security-policy',
    'keep-alive',
    'transfer-encoding',
    'x-frame-options',
  ]).has(name.toLowerCase())
}

function previewPath(previewId: string, pathname: string, search: string, token: string): string {
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  query.set('token', token)
  return `/api/preview/${encodeURIComponent(previewId)}${pathname.startsWith('/') ? pathname : `/${pathname}`}?${query.toString()}`
}

function rewriteHtml(html: string, previewId: string, token: string): string {
  const rewriteRootPath = (rootPath: string): string => {
    const [path = '', hash = ''] = rootPath.split('#', 2)
    const [pathname = '/', query = ''] = path.split('?', 2)
    const rewritten = previewPath(previewId, pathname === '' ? '/' : pathname, query, token)
    return `${rewritten}${hash === '' ? '' : `#${hash}`}`
  }
  return html
    .replace(/(\b(?:src|href|action)\s*=\s*["'])\/(?!\/)([^"']*)/gi, (_match, prefix: string, rootPath: string) => `${prefix}${rewriteRootPath(`/${rootPath}`)}`)
    .replace(/url\(\s*\/(?!\/)([^)]+)\)/gi, (_match, rootPath: string) => `url(${rewriteRootPath(`/${rootPath.trim()}`)})`)
}
