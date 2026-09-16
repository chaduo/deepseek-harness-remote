import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeepSeekHarnessAdapter, HarnessServerRequest } from '@dsh-remote/adapter-deepseek'
import { PushNotifier, type PushPayload, type PushSubscriptionRecord } from '../src/push-notifier.js'
import type { StructuredLogger } from '../src/logger.js'
import { RemoteHostServer } from '../src/server.js'

const logger: StructuredLogger = { info: () => {}, warn: () => {}, error: () => {} }

function adapterWithPushEvent(): DeepSeekHarnessAdapter {
  return {
    hostDescribe: async () => ({
      hostId: 'host_1',
      version: '0.1.0',
      cwd: process.cwd(),
      attachedSessions: 0,
      principalUserId: '',
      principalDeviceId: '',
    }),
    async *muxEvents(signal?: AbortSignal): AsyncGenerator<HarnessServerRequest> {
      yield {
        type: 'server-request',
        rpcId: 'rpc_1',
        method: 'approval/requested',
        payload: {
          type: 'approval/requested',
          sessionId: 'session_1',
          approvalId: 'approval_1',
          toolName: 'terminal',
        },
      }
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
    },
    close: () => {},
  } as unknown as DeepSeekHarnessAdapter
}

function rpcBody(method: string, payload: unknown): string {
  return JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), method, payload })
}

describe('RemoteHostServer push notifications', () => {
  let server: RemoteHostServer | undefined

  afterEach(async () => {
    await server?.close()
  })

  it('exposes VAPID and device-scoped subscription RPCs', async () => {
    const notifier = new PushNotifier({
      vapid: {
        subject: 'mailto:test@example.invalid',
        publicKey: 'public-vapid-key',
        privateKey: 'private-vapid-key',
      },
      send: async () => {},
    })
    server = new RemoteHostServer({
      hostId: 'host_1',
      adapter: adapterWithPushEvent(),
      logger,
      port: 0,
      pushNotifier: notifier,
    })
    const port = await server.start()
    const endpoint = `http://127.0.0.1:${port}/api/remote`
    const call = async (method: string, payload: unknown) => {
      const response = await fetch(`${endpoint}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
        },
        body: rpcBody(method, payload),
      })
      return await response.json() as Record<string, any>
    }

    expect((await call('push.vapid', {})).result.value).toMatchObject({ configured: true, publicKey: 'public-vapid-key' })
    const subscribed = await call('push.subscribe', {
      endpoint: 'https://push.example.test/1',
      keys: { p256dh: 'p256dh', auth: 'auth' },
      deviceName: 'test phone',
    })
    expect(subscribed.result.value.subscriptionId).toBeTruthy()
    expect((await call('push.list', {})).result.value.items).toHaveLength(1)
    expect((await call('push.unsubscribe', { subscriptionId: subscribed.result.value.subscriptionId })).result.value.accepted).toBe(true)
  })

  it('sends a background push for an approval event', async () => {
    const sent: PushPayload[] = []
    const initial: PushSubscriptionRecord = {
      subscriptionId: 'push_1',
      userId: 'tailnet-owner',
      deviceId: 'tailscale-serve',
      endpoint: 'https://push.example.test/1',
      keys: { p256dh: 'p256dh', auth: 'auth' },
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }
    const notifier = new PushNotifier({
      vapid: {
        subject: 'mailto:test@example.invalid',
        publicKey: 'public-vapid-key',
        privateKey: 'private-vapid-key',
      },
      initialSubscriptions: [initial],
      send: async (_subscription, payload) => sent.push(JSON.parse(payload) as PushPayload),
    })
    server = new RemoteHostServer({
      hostId: 'host_1',
      adapter: adapterWithPushEvent(),
      logger,
      port: 0,
      pushNotifier: notifier,
    })
    await server.start()

    for (let attempt = 0; attempt < 20 && sent.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(sent).toEqual([expect.objectContaining({ type: 'approval', url: '/?session=session_1' })])
  })
})
