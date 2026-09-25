# dsh-sub-providers

Clean-room DSH plugin: use your **Claude** and **ChatGPT (Codex)** subscriptions
as LLM provider routes — OAuth login from Settings → Subscriptions, streaming
chat, model catalogs in the session model picker, and subscription **usage**
display. No API keys.

This package is an independent implementation. **No code is taken from
dsh-plugin-subscriptions** (see "Clean-room guarantee" below).

## Status

| Phase | Scope | State |
|-------|-------|-------|
| 0 | Scaffold, build, profile install | done |
| 1 | Claude: OAuth login, streaming adapter, catalog, usage, settings UI | done — copy/paste login, awaiting live verification |
| 2 | Codex: OAuth, Responses-wire adapter, effort, catalog, usage+plan | done — verified live |
| 3 | UX polish: usage pill, locale strings | done |
| 4 | Hardening: security scan, full test pass, review | scan + 28 tests done |

## Install

```sh
# remove the original (its claude/codex routes would collide)
dsh plugin --profile web remove dsh-plugin-subscriptions

# install this one
dsh plugin --profile web add github:deskomor/dsh-sub-providers
```

Restart `dsh web` afterwards. Then: Settings → **Subscriptions** → Sign in
(Claude is a copy/paste flow — see the threat model below).

### Development install (local link)

```sh
dsh plugin --profile web add <path-to>/dsh-sub-providers

# pnpm on Windows rewrites the local link target incorrectly — repair it
pwsh scripts/repair-profile-link.ps1
```

With a local link, source rebuilds (`npm run build`) take effect on the next
`dsh web` restart without reinstalling. If you run any other `dsh plugin`
command, re-run the repair script afterwards.

## Build & test

```sh
npm install          # dev dependencies (types, esbuild)
npm run typecheck    # tsc --noEmit
npm run build        # bundles lib/index.js (host) + lib/client.js (client)
npm test             # node --test
npm run security-scan  # clean-room security gates
```

The compiled `lib/` bundles are committed, so installing from GitHub does not
need a toolchain; run `npm run build` after changing `src/`.

## Architecture

- `src/host/` — Cordis plugin (`apply`, `inject`, `Config`): registers the
  `LlmAdapter` under `claude`/`codex` routes **only while logged in**, owns the
  OAuth flows (loopback + copy/paste), token store, and the `sub-providers.*`
  endpoints it registers as exact Fetch routes on the shared `/api` channel.
- `src/client/` — browser module (ModuleLoader factory format) rendering the
  Settings → Subscriptions page; talks to the host only via the connection RPC.
- `src/shared/protocol.ts` — the RPC vocabulary shared by both halves.
- Token store: `~/.dsh/plugins/sub-providers/auth.json`, written atomically,
  mode 0600. Fields are validated structurally; unknown content is dropped.

## Security notes / threat model

- **Endpoint allowlist.** Every outbound URL is a public vendor endpoint
  (claude.ai / api.anthropic.com / auth.openai.com / chatgpt.com); the security
  scan asserts no other host literals exist in the source.
- **No dangerous APIs.** No `child_process`, `eval`, dynamic code loading,
  obfuscation, or hidden payload blobs (asserted by the scan).
- **No credential-store access.** The plugin cannot read the Claude Code
  credential store (macOS Keychain / `~/.claude/.credentials.json`) or any
  file outside its own directory — a deliberate scope decision vs. the
  original plugin.
- **Product-token nuance (both vendors).** The subscription endpoints expect
  requests presenting as their official CLI. `User-Agent` therefore PREPENDS
  the CLI product token to the harness attribution value, and the Codex
  backend additionally requires the public `originator: codex_cli_rs` header
  — attribution is never suppressed, only joined.
- **Fixed Codex redirect.** The public Codex OAuth client registers exactly
  one redirect (`http://localhost:1455/auth/callback`), so that login binds
  the fixed port instead of an OS-assigned one and reuses the registered URI
  verbatim; the port is held only while a sign-in is pending.
- **Claude login is copy/paste (no local server).** The Claude Code OAuth
  client registers exactly one redirect — the hosted
  `https://console.anthropic.com/oauth/code/callback` page — and rejects
  loopback URIs. The flow therefore uses the documented `code=true`
  copy/paste mode: the callback page shows the code and you paste it back
  into Settings → Subscriptions (accepts `CODE` or `CODE#STATE`).
- **OAuth client ids** (Claude and Codex) come from publicly documented
  community knowledge and are configurable; nothing else is vendor-undocumented.
- Third-party caution applies to this package too: review the source (it is
  small and unobfuscated) before installing.

## Clean-room guarantee

Allowed inputs: public vendor API documentation, `@deepseek-ai/*` type
contracts shipped with the harness, and the original plugin's *README*
(behavior spec only). The original's source/bundles were not transcribed;
`scripts/security-scan.mjs` re-checks the structural gates on every build.
