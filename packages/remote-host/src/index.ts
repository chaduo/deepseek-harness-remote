export { DeepSeekHarnessAdapter, HarnessAdapterError } from '@dsh-remote/adapter-deepseek'
export { JsonLogger } from './logger.js'
export type { StructuredLogger } from './logger.js'
export { loadOrCreateHostIdentity, persistHostDeviceKey, defaultHostStateFile } from './host-identity.js'
export type { HostIdentity, HostDeviceKeyRecord } from './host-identity.js'
export { loopbackPrincipal } from './principal.js'
export { MonotonicSequence, toRemoteEnvelope } from './event-enveloper.js'
export { CaffeinateSupervisor } from './caffeinate.js'
export { IdempotencyStore } from './idempotency-store.js'
export { CheckRunner, loadCheckDefinitions } from './check-runner.js'
export type { CheckDefinition, CheckRun, CheckRunnerEvent, CheckStatus } from './check-runner.js'
export { PreviewProxy, PreviewProxyError, loadPreviewDefinitions } from './preview-proxy.js'
export type {
  PreviewDefinition,
  PreviewDefinitionSummary,
  PreviewOpenResult,
  PreviewProxyRequest,
  PreviewProxyResponse,
} from './preview-proxy.js'
export {
  JsonPushSubscriptionStore,
  loadOrCreateVapidDetails,
  PushNotifier,
  pushNoticeFor,
} from './push-notifier.js'
export type {
  PushNotifyResult,
  PushPayload,
  PushSubscriptionInput,
  PushSubscriptionRecord,
  PushSubscriptionStore,
  PushSubscriptionSummary,
  VapidDetails,
} from './push-notifier.js'
export { parseProxyProtocolLine, isLoopbackIp } from './proxy-protocol.js'
export { MacKeychainSecretStore } from './keychain.js'
export type { SecretStore } from './keychain.js'
export { ensureHostDeviceKey, deviceKeyAccount, fingerprint } from './host-device-key.js'
export type { HostDeviceKeyProvision } from './host-device-key.js'
export { TailscaleCliIdentityProvider } from './tailscale-identity.js'
export type { TailscaleIdentityProvider, TailscalePeerIdentity } from './tailscale-identity.js'
export { RemoteHostServer } from './server.js'
export type { RemoteHostServerOptions } from './server.js'
