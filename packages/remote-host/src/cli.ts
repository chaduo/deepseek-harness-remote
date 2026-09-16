import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { DeepSeekHarnessAdapter } from '@dsh-remote/adapter-deepseek'
import { CaffeinateSupervisor } from './caffeinate.js'
import { CheckRunner, loadCheckDefinitions } from './check-runner.js'
import { ensureHostDeviceKey } from './host-device-key.js'
import { JsonLogger } from './logger.js'
import { defaultHostStateFile, loadOrCreateHostIdentity, persistHostDeviceKey } from './host-identity.js'
import { MacKeychainSecretStore } from './keychain.js'
import { RemoteHostServer } from './server.js'
import { PreviewProxy, loadPreviewDefinitions } from './preview-proxy.js'
import {
  JsonPushSubscriptionStore,
  loadOrCreateVapidDetails,
  PushNotifier,
} from './push-notifier.js'
import { TailscaleCliIdentityProvider } from './tailscale-identity.js'

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value}`)
  }
  return port
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'harness-url': { type: 'string' },
    'state-file': { type: 'string' },
    'static-dir': { type: 'string' },
    'user-id': { type: 'string' },
    'device-id': { type: 'string' },
    caffeinate: { type: 'string' },
    'identity-provider': { type: 'string' },
    'allowed-device-ids': { type: 'string' },
    'secret-store': { type: 'string' },
    'checks-file': { type: 'string' },
    'previews-file': { type: 'string' },
    'vapid-keys-file': { type: 'string' },
    'push-subscriptions-file': { type: 'string' },
  },
  allowPositionals: false,
})

const logger = new JsonLogger()
const stateFile = values['state-file'] ?? process.env.DSH_REMOTE_STATE_FILE ?? defaultHostStateFile()
const identity = loadOrCreateHostIdentity({ stateFile })
const harnessUrl = values['harness-url'] ?? process.env.DSH_REMOTE_HARNESS_URL ?? 'http://127.0.0.1:3080'
const staticDir = values['static-dir'] ?? process.env.DSH_REMOTE_STATIC_DIR
const adapter = new DeepSeekHarnessAdapter({
  baseUrl: harnessUrl,
  hostId: identity.hostId,
})
const port = values.port ?? process.env.DSH_REMOTE_PORT
const userId = values['user-id'] ?? process.env.DSH_REMOTE_USER_ID
const deviceId = values['device-id'] ?? process.env.DSH_REMOTE_DEVICE_ID
const caffeinateMode = values.caffeinate ?? process.env.DSH_REMOTE_CAFFEINATE ?? 'off'
if (!['off', 'auto'].includes(caffeinateMode)) {
  throw new Error(`invalid caffeinate mode: ${caffeinateMode} (expected off|auto)`)
}
const caffeinate = caffeinateMode === 'auto'
  ? new CaffeinateSupervisor({ adapter, logger })
  : undefined
const identityMode = values['identity-provider'] ?? process.env.DSH_REMOTE_IDENTITY_PROVIDER ?? 'tailscale'
if (!['tailscale', 'none'].includes(identityMode)) {
  throw new Error(`invalid identity provider: ${identityMode} (expected tailscale|none)`)
}
const identityProvider = identityMode === 'tailscale'
  ? new TailscaleCliIdentityProvider({ logger })
  : undefined
const allowedDeviceIds = (values['allowed-device-ids'] ?? process.env.DSH_REMOTE_ALLOWED_DEVICE_IDS)
  ?.split(',')
  .map(value => value.trim())
  .filter(value => value.length > 0)
const secretStoreMode = values['secret-store'] ?? process.env.DSH_REMOTE_SECRET_STORE ?? 'mac-keychain'
if (!['mac-keychain', 'none'].includes(secretStoreMode)) {
  throw new Error(`invalid secret store: ${secretStoreMode} (expected mac-keychain|none)`)
}
const secretStore = secretStoreMode === 'mac-keychain'
  ? new MacKeychainSecretStore({ logger })
  : undefined
const checksFile = nonEmpty(values['checks-file']) ?? nonEmpty(process.env.DSH_REMOTE_CHECKS_FILE)
const checkRunner = checksFile === undefined
  ? undefined
  : new CheckRunner({ definitions: await loadCheckDefinitions(checksFile) })
const previewsFile = nonEmpty(values['previews-file']) ?? nonEmpty(process.env.DSH_REMOTE_PREVIEWS_FILE)
const previewProxy = previewsFile === undefined
  ? undefined
  : new PreviewProxy({
      definitions: await loadPreviewDefinitions(previewsFile),
      secret: nonEmpty(process.env.DSH_REMOTE_PREVIEW_SECRET) ?? randomBytes(32),
    })
const vapidSubject = nonEmpty(process.env.DSH_REMOTE_VAPID_SUBJECT) ?? 'mailto:dsh-remote@example.invalid'
const vapidPublicKey = nonEmpty(process.env.DSH_REMOTE_VAPID_PUBLIC_KEY)
const vapidPrivateKey = nonEmpty(process.env.DSH_REMOTE_VAPID_PRIVATE_KEY)
if ((vapidPublicKey === undefined) !== (vapidPrivateKey === undefined)) {
  throw new Error('DSH_REMOTE_VAPID_PUBLIC_KEY and DSH_REMOTE_VAPID_PRIVATE_KEY must be configured together')
}
const vapidDetails = vapidPublicKey !== undefined && vapidPrivateKey !== undefined
  ? { subject: vapidSubject, publicKey: vapidPublicKey, privateKey: vapidPrivateKey }
  : await loadOrCreateVapidDetails(
      nonEmpty(values['vapid-keys-file']) ?? nonEmpty(process.env.DSH_REMOTE_VAPID_KEYS_FILE) ?? `${stateFile}.vapid.json`,
      vapidSubject,
    )
const pushSubscriptionsStore = new JsonPushSubscriptionStore(
  nonEmpty(values['push-subscriptions-file']) ?? nonEmpty(process.env.DSH_REMOTE_PUSH_SUBSCRIPTIONS_FILE) ?? `${stateFile}.push.json`,
)
const pushNotifier = new PushNotifier({
  vapid: vapidDetails,
  initialSubscriptions: await pushSubscriptionsStore.load(),
  persist: subscriptions => pushSubscriptionsStore.save(subscriptions),
})
const deviceKey = secretStore !== undefined
  ? await (async () => {
      try {
        const key = await ensureHostDeviceKey(secretStore, identity.hostId)
        persistHostDeviceKey(stateFile, {
          publicKeyPem: key.publicKeyPem,
          fingerprint: key.fingerprint,
        })
        return key
      } catch (error) {
        logger.warn({ error: String(error) }, 'device key provisioning failed; continuing without device key')
        return undefined
      }
    })()
  : undefined
const server = new RemoteHostServer({
  hostId: identity.hostId,
  adapter,
  logger,
  host: values.host ?? '127.0.0.1',
  port: port !== undefined ? parsePort(port) : 3090,
  ...(staticDir !== undefined && { staticDir }),
  ...(userId !== undefined && { userId }),
  ...(deviceId !== undefined && { deviceId }),
  ...(caffeinate !== undefined && { caffeinate }),
  ...(identityProvider !== undefined && { identityProvider }),
  ...(allowedDeviceIds !== undefined && allowedDeviceIds.length > 0 && { allowedDeviceIds }),
  ...(checkRunner !== undefined && { checkRunner }),
  ...(previewProxy !== undefined && { previewProxy }),
  pushNotifier,
})

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({}, 'shutting down remote host')
  await server.close()
  process.exit(0)
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

try {
  await server.start()
  logger.info({
    harnessUrl,
    hostId: identity.hostId,
    ...(deviceKey !== undefined && {
      deviceKeyFingerprint: deviceKey.fingerprint,
      deviceKeyCreated: deviceKey.created,
      deviceKeyPersisted: true,
    }),
    pushPublicKey: pushNotifier.publicKey(),
  }, 'dsh-remote-host ready')
} catch (error) {
  logger.error({ error: String(error) }, 'failed to start remote host')
  process.exit(1)
}
