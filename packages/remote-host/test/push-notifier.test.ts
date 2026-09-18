import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RemotePrincipal } from '@dsh-remote/protocol'
import {
  loadOrCreateVapidDetails,
  PushNotifier,
  pushNoticeFor,
  type PushPayload,
  type PushSubscriptionInput,
} from '../src/push-notifier.js'

const principal: RemotePrincipal = {
  userId: 'user_1',
  deviceId: 'phone_1',
  hostId: 'host_1',
  roles: ['owner'],
}

const subscription: PushSubscriptionInput = {
  endpoint: 'https://push.example.test/subscription/1',
  keys: {
    p256dh: 'public-key',
    auth: 'auth-secret',
  },
  deviceName: 'iPhone',
}

describe('PushNotifier', () => {
  it('creates and persists VAPID details when no key file exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-vapid-test-'))
    const filePath = join(directory, 'vapid.json')

    try {
      const details = await loadOrCreateVapidDetails(filePath, 'mailto:test@example.invalid')
      const saved = JSON.parse(await readFile(filePath, 'utf8')) as typeof details

      expect(details.subject).toBe('mailto:test@example.invalid')
      expect(details.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(details.privateKey).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(saved).toEqual(details)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('migrates an existing VAPID subject without rotating its keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-vapid-migration-test-'))
    const filePath = join(directory, 'vapid.json')
    const original = {
      subject: 'mailto:dsh-remote@example.invalid',
      publicKey: 'existing-public-key',
      privateKey: 'existing-private-key',
    }

    try {
      await writeFile(filePath, JSON.stringify(original), 'utf8')

      const details = await loadOrCreateVapidDetails(filePath, 'mailto:dsh-remote@example.com')
      const saved = JSON.parse(await readFile(filePath, 'utf8')) as typeof details

      expect(details).toEqual({ ...original, subject: 'mailto:dsh-remote@example.com' })
      expect(saved).toEqual(details)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('registers one subscription per endpoint and sends payloads', async () => {
    const sent: PushPayload[] = []
    const notifier = new PushNotifier({
      vapid: {
        subject: 'mailto:test@example.invalid',
        publicKey: 'public-vapid-key',
        privateKey: 'private-vapid-key',
      },
      send: async (_subscription, payload) => sent.push(JSON.parse(payload) as PushPayload),
      now: () => 1_700_000_000_000,
      newId: () => 'push_1',
    })

    const first = await notifier.subscribe(principal, subscription)
    const second = await notifier.subscribe(principal, { ...subscription, deviceName: 'iPhone renamed' })

    expect(first.subscriptionId).toBe('push_1')
    expect(second.subscriptionId).toBe('push_1')
    expect(notifier.list(principal)).toMatchObject([{ subscriptionId: 'push_1', deviceName: 'iPhone renamed' }])

    await notifier.notify({
      type: 'approval',
      title: '需要处理审批',
      body: 'Agent 请求运行命令',
      url: '/?session=session_1',
      tag: 'approval:approval_1',
    })
    expect(sent).toEqual([expect.objectContaining({ type: 'approval', tag: 'approval:approval_1' })])
  })

  it('removes subscriptions rejected by the push service', async () => {
    const notifier = new PushNotifier({
      vapid: {
        subject: 'mailto:test@example.invalid',
        publicKey: 'public-vapid-key',
        privateKey: 'private-vapid-key',
      },
      send: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }) },
      newId: () => 'push_1',
    })
    await notifier.subscribe(principal, subscription)

    const result = await notifier.notify({
      type: 'question',
      title: '需要回答问题',
      body: 'Agent 正在等待你的选择',
      url: '/?session=session_1',
      tag: 'question:question_1',
    })

    expect(result).toEqual({ sent: 0, removed: 1, failed: 0 })
    expect(notifier.list(principal)).toEqual([])
  })

  it('reports non-terminal push failures without deleting the subscription', async () => {
    const notifier = new PushNotifier({
      vapid: {
        subject: 'mailto:test@example.invalid',
        publicKey: 'public-vapid-key',
        privateKey: 'private-vapid-key',
      },
      send: async () => { throw Object.assign(new Error('bad jwt'), { statusCode: 403 }) },
      newId: () => 'push_1',
    })
    await notifier.subscribe(principal, subscription)

    const result = await notifier.notify({
      type: 'session',
      title: '任务已完成',
      body: '打开任务查看 Agent 结果',
      url: '/?session=session_1',
      tag: 'session:session_1:finished',
    })

    expect(result).toEqual({ sent: 0, removed: 0, failed: 1 })
    expect(notifier.list(principal)).toHaveLength(1)
  })

  it('turns upstream attention events into deep-linked notices', () => {
    expect(pushNoticeFor({
      type: 'server-request',
      rpcId: 'rpc_1',
      method: 'approval/requested',
      payload: { type: 'approval/requested', sessionId: 'session_1', approvalId: 'approval_1', toolName: 'terminal' },
    })).toEqual(expect.objectContaining({
      type: 'approval',
      tag: 'approval:approval_1',
      url: '/?session=session_1',
    }))
    expect(pushNoticeFor({
      type: 'server-request',
      rpcId: 'rpc_2',
      method: 'question/requested',
      payload: { type: 'question/requested', sessionId: 'session_2', questions: [{ question: '继续吗？' }] },
    })).toEqual(expect.objectContaining({
      type: 'question',
      tag: 'question:rpc_2',
    }))
    expect(pushNoticeFor({
      type: 'server-request',
      rpcId: 'rpc_3',
      method: 'session/event',
      payload: { type: 'session/event', sessionId: 'session_3', event: { type: 'session/completed' } },
    })).toEqual(expect.objectContaining({ type: 'session', url: '/?session=session_3' }))
    expect(pushNoticeFor({
      type: 'server-request',
      rpcId: 'rpc_4',
      method: 'session/status',
      payload: { type: 'session/status', sessionId: 'session_4', running: false },
    })).toEqual(expect.objectContaining({ type: 'session', url: '/?session=session_4' }))
    expect(pushNoticeFor({
      type: 'server-request',
      rpcId: 'rpc_5',
      method: 'session/status',
      payload: { type: 'session/status', sessionId: 'session_5', running: true },
    })).toBeUndefined()
    expect(pushNoticeFor({
      type: 'server-request',
      rpcId: 'rpc_6',
      method: 'session/error',
      payload: { type: 'session/error', sessionId: 'session_6', message: 'failed' },
    })).toEqual(expect.objectContaining({ type: 'session', url: '/?session=session_6' }))
  })
})
