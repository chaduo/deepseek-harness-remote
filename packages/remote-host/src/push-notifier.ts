import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HarnessServerRequest } from '@dsh-remote/adapter-deepseek'
import type { RemotePrincipal } from '@dsh-remote/protocol'
import webpush from 'web-push'
import type { PushSubscription as WebPushSubscription, RequestOptions, VapidKeys } from 'web-push'

// web-push is CommonJS. Depending on the Node loader that starts the LaunchAgent,
// a default import can be either the API object or a namespace containing it.
const webPushApi = ((webpush as unknown as { default?: typeof webpush }).default ?? webpush)

const PUSH_TTL_SECONDS = 5 * 60

export interface VapidDetails {
  subject: string
  publicKey: string
  privateKey: string
}

export interface PushSubscriptionInput {
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
  deviceName?: string
}

export interface PushSubscriptionRecord extends PushSubscriptionInput {
  subscriptionId: string
  userId: string
  deviceId: string
  createdAt: string
  lastSeenAt: string
}

export interface PushSubscriptionSummary {
  subscriptionId: string
  deviceName?: string
  createdAt: string
  lastSeenAt: string
}

export type PushPayloadType = 'approval' | 'question' | 'session' | 'check'

export interface PushPayload {
  type: PushPayloadType
  title: string
  body: string
  url: string
  tag: string
}

export interface PushNotifierOptions {
  vapid: VapidDetails
  initialSubscriptions?: readonly PushSubscriptionRecord[]
  persist?: (subscriptions: readonly PushSubscriptionRecord[]) => Promise<void>
  send?: (subscription: WebPushSubscription, payload: string, options: RequestOptions) => Promise<unknown>
  now?: () => number
  newId?: () => string
}

export interface PushNotifyResult {
  sent: number
  removed: number
  failed: number
}

export interface PushSubscriptionStore {
  load(): Promise<PushSubscriptionRecord[]>
  save(subscriptions: readonly PushSubscriptionRecord[]): Promise<void>
}

export class JsonPushSubscriptionStore implements PushSubscriptionStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PushSubscriptionRecord[]> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (!Array.isArray(value)) throw new Error('push subscription file must contain an array')
      return value.filter(isPushSubscriptionRecord)
    } catch (error) {
      if (isFileMissing(error)) return []
      throw error
    }
  }

  async save(subscriptions: readonly PushSubscriptionRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(subscriptions, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }
}

export async function loadOrCreateVapidDetails(filePath: string, subject: string): Promise<VapidDetails> {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as Partial<VapidDetails>
    if (
      typeof value.subject === 'string'
      && typeof value.publicKey === 'string'
      && typeof value.privateKey === 'string'
      && value.publicKey !== ''
      && value.privateKey !== ''
    ) {
      const details: VapidDetails = {
        subject,
        publicKey: value.publicKey,
        privateKey: value.privateKey,
      }
      if (value.subject !== subject) {
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, JSON.stringify(details, null, 2), { encoding: 'utf8', mode: 0o600 })
      }
      return details
    }
  } catch (error) {
    if (!isFileMissing(error)) throw error
  }

  const keys: VapidKeys = webPushApi.generateVAPIDKeys()
  const details: VapidDetails = { subject, ...keys }
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(details, null, 2), { encoding: 'utf8', mode: 0o600 })
  return details
}

export class PushNotifier {
  private readonly vapid: VapidDetails
  private readonly subscriptions = new Map<string, PushSubscriptionRecord>()
  private readonly persist: ((subscriptions: readonly PushSubscriptionRecord[]) => Promise<void>) | undefined
  private readonly send: (subscription: WebPushSubscription, payload: string, options: RequestOptions) => Promise<unknown>
  private readonly now: () => number
  private readonly newId: () => string
  private readonly sentTags = new Map<string, number>()

  constructor(options: PushNotifierOptions) {
    this.vapid = { ...options.vapid }
    this.persist = options.persist
    this.send = options.send ?? ((subscription, payload, sendOptions) => webPushApi.sendNotification(subscription, payload, sendOptions))
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => crypto.randomUUID())
    for (const subscription of options.initialSubscriptions ?? []) {
      this.subscriptions.set(subscription.subscriptionId, { ...subscription, keys: { ...subscription.keys } })
    }
  }

  publicKey(): string {
    return this.vapid.publicKey
  }

  list(principal: RemotePrincipal): PushSubscriptionSummary[] {
    return [...this.subscriptions.values()]
      .filter(subscription => this.owns(subscription, principal))
      .map(subscription => ({
        subscriptionId: subscription.subscriptionId,
        ...(subscription.deviceName !== undefined && { deviceName: subscription.deviceName }),
        createdAt: subscription.createdAt,
        lastSeenAt: subscription.lastSeenAt,
      }))
  }

  async subscribe(principal: RemotePrincipal, input: PushSubscriptionInput): Promise<{ subscriptionId: string }> {
    validateSubscription(input)
    const now = new Date(this.now()).toISOString()
    const existing = [...this.subscriptions.values()].find(subscription => (
      subscription.endpoint === input.endpoint
      && this.owns(subscription, principal)
    ))
    const record: PushSubscriptionRecord = {
      subscriptionId: existing?.subscriptionId ?? this.newId(),
      userId: principal.userId,
      deviceId: principal.deviceId,
      endpoint: input.endpoint,
      keys: { ...input.keys },
      ...(input.deviceName !== undefined && { deviceName: input.deviceName }),
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
    }
    const previous = this.subscriptions.get(record.subscriptionId)
    this.subscriptions.set(record.subscriptionId, record)
    try {
      await this.save()
    } catch (error) {
      if (previous === undefined) this.subscriptions.delete(record.subscriptionId)
      else this.subscriptions.set(record.subscriptionId, previous)
      throw error
    }
    return { subscriptionId: record.subscriptionId }
  }

  async unsubscribe(principal: RemotePrincipal, input: { subscriptionId?: string; endpoint?: string }): Promise<{ accepted: boolean }> {
    const record = [...this.subscriptions.values()].find(candidate => (
      this.owns(candidate, principal)
      && (
        (input.subscriptionId !== undefined && candidate.subscriptionId === input.subscriptionId)
        || (input.endpoint !== undefined && candidate.endpoint === input.endpoint)
      )
    ))
    if (record === undefined) return { accepted: false }
    this.subscriptions.delete(record.subscriptionId)
    await this.save()
    return { accepted: true }
  }

  async notify(payload: PushPayload): Promise<PushNotifyResult> {
    const now = this.now()
    const previous = this.sentTags.get(payload.tag)
    if (previous !== undefined && now - previous < PUSH_TTL_SECONDS * 1_000) {
      return { sent: 0, removed: 0, failed: 0 }
    }
    const serialized = JSON.stringify(payload)
    let sent = 0
    let removed = 0
    let failed = 0
    for (const record of [...this.subscriptions.values()]) {
      try {
        await this.send(record, serialized, {
          TTL: PUSH_TTL_SECONDS,
          timeout: 10_000,
          vapidDetails: this.vapid,
        })
        sent += 1
      } catch (error) {
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : undefined
        if (statusCode === 404 || statusCode === 410) {
          this.subscriptions.delete(record.subscriptionId)
          removed += 1
        } else {
          failed += 1
        }
      }
    }
    if (removed > 0) await this.save()
    if (sent > 0) this.sentTags.set(payload.tag, now)
    for (const [tag, sentAt] of this.sentTags) {
      if (now - sentAt >= PUSH_TTL_SECONDS * 1_000) this.sentTags.delete(tag)
    }
    return { sent, removed, failed }
  }

  private owns(subscription: PushSubscriptionRecord, principal: RemotePrincipal): boolean {
    return subscription.userId === principal.userId && subscription.deviceId === principal.deviceId
  }

  private async save(): Promise<void> {
    await this.persist?.([...this.subscriptions.values()].map(subscription => ({
      ...subscription,
      keys: { ...subscription.keys },
    })))
  }
}

export function pushNoticeFor(message: HarnessServerRequest): PushPayload | undefined {
  const payload = record(message.payload)
  const type = typeof payload?.type === 'string' ? payload.type : message.method
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
  const url = sessionId === undefined ? '/' : `/?session=${encodeURIComponent(sessionId)}`

  if (type === 'approval/requested') {
    const toolName = typeof payload?.toolName === 'string' ? payload.toolName : 'Agent 操作'
    const approvalId = typeof payload?.approvalId === 'string' ? payload.approvalId : message.rpcId
    return {
      type: 'approval',
      title: '需要处理审批',
      body: `${toolName} 请求你的允许`,
      url,
      tag: `approval:${approvalId}`,
    }
  }
  if (type === 'question/requested') {
    return {
      type: 'question',
      title: 'Agent 正在等你回答',
      body: '打开任务继续回答问题',
      url,
      tag: `question:${message.rpcId}`,
    }
  }
  if (type === 'session/event') {
    const event = record(payload?.event)
    const eventType = typeof event?.type === 'string' ? event.type : ''
    if (eventType === 'session/completed' || eventType === 'session/finished' || eventType === 'session/failed') {
      const failed = eventType === 'session/failed'
      return {
        type: 'session',
        title: failed ? '任务执行失败' : '任务已完成',
        body: failed ? '打开任务查看失败原因' : '打开任务查看 Agent 结果',
        url,
        tag: `session:${sessionId ?? message.rpcId}:${failed ? 'failed' : 'finished'}`,
      }
    }
  }
  if (type === 'session/status' && payload?.running === false) {
    return {
      type: 'session',
      title: '任务已完成',
      body: '打开任务查看 Agent 结果',
      url,
      tag: `session:${sessionId ?? message.rpcId}:finished`,
    }
  }
  if (type === 'session/error') {
    return {
      type: 'session',
      title: '任务执行失败',
      body: '打开任务查看失败原因',
      url,
      tag: `session:${sessionId ?? message.rpcId}:failed`,
    }
  }
  return undefined
}

function validateSubscription(input: PushSubscriptionInput): void {
  let endpoint: URL
  try {
    endpoint = new URL(input.endpoint)
  } catch {
    throw new Error('push endpoint is not a valid URL')
  }
  if (endpoint.protocol !== 'https:') throw new Error('push endpoint must use HTTPS')
  if (input.keys.p256dh.trim() === '' || input.keys.auth.trim() === '') {
    throw new Error('push subscription keys are required')
  }
}

function isPushSubscriptionRecord(value: unknown): value is PushSubscriptionRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const keys = record.keys as Record<string, unknown> | undefined
  return (
    typeof record.subscriptionId === 'string'
    && typeof record.userId === 'string'
    && typeof record.deviceId === 'string'
    && typeof record.endpoint === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.lastSeenAt === 'string'
    && keys !== undefined
    && typeof keys.p256dh === 'string'
    && typeof keys.auth === 'string'
    && (record.deviceName === undefined || typeof record.deviceName === 'string')
  )
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function isFileMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
