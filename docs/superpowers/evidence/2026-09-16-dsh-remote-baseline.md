# DSH Remote baseline — 2026-09-16

## Source

- Repository: `https://github.com/Zouu-X/dsh_remote`
- Local copy: `/Users/zhaozhuo/agent-pocket/dsh-remote`
- Commit: `a18ce28abec513421d79fe862f680be3f15d20df`
- Node: `v24.19.0` (the repository declares `>=24`; the system default `v22.23.2` was not used)
- pnpm: `11.19.0`

## Automated baseline

Commands run from the repository root:

```text
corepack pnpm install --frozen-lockfile   PASS
corepack pnpm typecheck                   PASS
corepack pnpm test                        PASS — 96 tests
corepack pnpm build                       PASS — Vite production bundle emitted
node tools/remote-host-check/check.mjs --help  PASS — diagnostic CLI starts
```

The baseline test suites reported 7 files/packages with 96 passing tests:

- remote-protocol: 5
- auth-core: 4
- remote-domain: 16
- adapter-deepseek: 7
- remote-client: 10
- mobile-web: 6
- remote-host: 48

## What this does not prove

The checks above do not prove that a local DeepSeek Harness instance is compatible with this commit, that Tailscale Serve is configured, that Web Push credentials exist, or that an iPhone can complete the real workflow. Those are separate acceptance tests.

## Initial product baseline

The existing repository already contains a mobile task UI, Remote Host/Client protocol, DSH adapter, reconnect logic, event gap detection, write idempotency, and a service worker shell cache. New work must describe its own contribution relative to these existing capabilities.
