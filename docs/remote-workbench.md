# Remote Workbench engineering notes

This document records the project contribution on top of the upstream DSH Remote repository. The goal is a phone workbench for a Mac-hosted DeepSeek Harness, with a small, reviewable remote surface.

## Contribution boundary

The upstream repository already provides the basic mobile conversation, approvals, sessions, event streaming, and Tailscale entry point. The added workbench layer focuses on three gaps that affect daily use:

1. **Mobile continuity**: each session has a versioned local draft. Switching sessions keeps text isolated, and a late response cannot erase newer text typed by the user.
2. **Remote verification**: the Mac runs only commands declared in a JSON allowlist. The phone receives queued/running/finished events, bounded logs, exit codes, timeout state, and a workspace fingerprint.
3. **Human-in-the-loop delivery**: a loopback-only preview proxy exposes a selected local Web server through a short-lived, device-bound token; VAPID Web Push delivers approvals, questions, task completion, and check results while the phone is in the background.

## Main technical choices

| Area | Choice | Reason |
| --- | --- | --- |
| mobile client | React/Vite PWA | Reuses the existing web UI and works on Android and iPhone without an Apple developer account |
| remote boundary | typed `RemoteApiMap` plus capability allowlist | Keeps the phone surface explicit and prevents arbitrary Harness RPCs |
| project checks | `spawn(command, args, { shell: false })` | Remote input selects a known check; it never becomes a shell command |
| repeatable writes | scoped idempotency keys | A reconnect or tap retry cannot start the same task/check twice |
| preview access | loopback target allowlist + HMAC token | The phone can reach a local dev server without turning the Host into an open proxy |
| notification delivery | VAPID Web Push + Service Worker | Background delivery avoids a permanent phone WebSocket and supports installed iOS PWAs |
| persistence | JSON files with atomic rename | Keeps the personal Mac deployment simple while retaining Host identity, VAPID keys, and subscriptions across restarts |

## Mobile test flow

The intended real-device flow is:

1. Open the PWA through the Mac's Tailscale Serve HTTPS address.
2. Open a task and type a draft.
3. Switch to another task and type a second draft; switch back and confirm both drafts remain.
4. Trigger `typecheck`, `test`, or `build` from the task page and inspect the streaming log.
5. Open a configured Web preview and interact with the page inside the task view.
6. Add the PWA to the iPhone home screen, enable notifications, background the app, then trigger an approval or a check completion.
7. Tap the notification and confirm that the matching Session opens.

The final iPhone step is an acceptance test rather than a TypeScript unit test because Safari notification permission and Web Push delivery depend on the real device and HTTPS origin.

## Current verification evidence

Run with the repository's Node 24 runtime:

```text
pnpm typecheck  ✓
pnpm build      ✓
pnpm test       ✓  7 packages, 18 Remote Host test files, 65 Remote Host tests, 10 mobile tests
```

The automated coverage includes real local HTTP targets, real child processes, protected preview requests, token expiry and path-escape rejection, subscription RPCs, stale Push endpoint removal, and server-side approval-to-push delivery.

## Known product boundary

The preview proxy rewrites root-relative HTML resource URLs. A project that hard-codes an absolute API origin still needs its own development-server base-path configuration. The iPhone Push path requires iOS 16.4 or newer, an installed PWA, notification permission, and a persistent VAPID key pair.
