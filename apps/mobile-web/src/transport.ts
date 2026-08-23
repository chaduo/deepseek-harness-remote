import { DirectTailnetTransport } from '@dsh-remote/client'

/**
 * UI never constructs fetch/WebSocket calls directly. In production the app
 * is served by the Remote Host Adapter, so the transport uses the current
 * origin. VITE_REMOTE_BASE is only for local Vite development.
 */
const baseUrl = (import.meta.env.VITE_REMOTE_BASE as string | undefined) ?? window.location.origin

// A short stream handshake deadline keeps the reconnect budget honest: with
// the default it would take minutes of "正在连接" before the phone admits the
// Mac is unreachable. RPCs keep the transport default.
export const transport = new DirectTailnetTransport({ baseUrl, eventOpenTimeoutMs: 8_000 })
