# @y00njinuk/opencode-claude-auth

[![npm](https://img.shields.io/npm/v/@y00njinuk/opencode-claude-auth)](https://www.npmjs.com/package/@y00njinuk/opencode-claude-auth)
[![CI](https://github.com/y00njinuk/opencode-claude-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/y00njinuk/opencode-claude-auth/actions/workflows/ci.yml)

Self-contained Anthropic auth provider for OpenCode using your Claude Code credentials — no separate login or API key needed.

> **This is a fork** of [griffinmartin/opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth), published to npm as `@y00njinuk/opencode-claude-auth` and maintained independently. Changes in this fork are not sent upstream, so version numbers here do not line up with the original package. Install one or the other, never both — two copies of the plugin would each run their own refresh timer against the same credentials.
>
> Fork-only change:
>
> - **The `claude` CLI performs token refreshes; the plugin never calls the OAuth token endpoint itself.** Upstream refreshes in-process, which fails on any network that blocks or TLS-intercepts `claude.ai` while allowing `api.anthropic.com` — common on corporate networks. Delegating to the CLI also means this plugin never has to persist a rotated refresh token, removing the failure where a lost write-back leaves the account unrecoverable without an interactive re-login. The cost is that a refresh runs `claude -p . --model haiku`: one small billed request and a brief freeze, a handful of times a day. Tunable via `OPENCODE_CLAUDE_AUTH_CLI_TIMEOUT_MS` and `OPENCODE_CLAUDE_AUTH_CLI_COOLDOWN_MS`. See [Appendix: 토큰 정책](#appendix-토큰-정책-한글).

## How it works

The plugin registers its own auth provider with a custom fetch handler that intercepts all Anthropic API requests. It reads OAuth tokens from the macOS Keychain (or `~/.claude/.credentials.json` — or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set — on other platforms), caches them in memory with a 30-second TTL, and handles the full request lifecycle — no builtin Anthropic auth plugin required. On macOS, multiple Claude Code accounts are detected automatically and can be switched via `opencode auth login`.

It also syncs credentials to OpenCode's `auth.json` as a fallback (on Windows, it writes to both `%USERPROFILE%\.local\share\opencode\auth.json` and `%LOCALAPPDATA%\opencode\auth.json` to cover all installation methods). If a token is within 60 seconds of expiry, it runs the `claude` CLI and reads back whatever that wrote to the credential store — the CLI owns the store and rotates and persists in one step, so the plugin never holds a rotated token it has to save. The background re-sync every 5 minutes only mirrors already-valid credentials into `auth.json`; it never refreshes.

## Prerequisites

- Claude Code installed and authenticated (run `claude` at least once)
- OpenCode installed

macOS is preferred (uses Keychain). Linux and Windows work via the credentials file fallback.

## Installation

**For Humans**

**Option A: Let an LLM do it**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the @y00njinuk/opencode-claude-auth plugin and configure it by following: https://raw.githubusercontent.com/y00njinuk/opencode-claude-auth/main/installation.md
```

**Option B: Manual setup**

1. **Add the plugin** to `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugin": ["@y00njinuk/opencode-claude-auth@latest"]
   }
   ```

   > The `@latest` tag ensures OpenCode always pulls the newest version on startup. No manual `npm install` is needed — OpenCode [automatically installs npm plugins using Bun at startup](https://opencode.ai/docs/plugins/#how-plugins-are-installed).

2. **Use it** — just run OpenCode. The plugin handles auth automatically using your Claude Code credentials.

**For LLM Agents**

See [installation.md](installation.md) for step-by-step agent instructions.

## Usage

Just run OpenCode. The plugin handles auth automatically — it reads your Claude Code credentials, provides them to the Anthropic API, and refreshes them in the background. If your credentials aren't OAuth-based, the plugin falls through to standard API key auth.

## Supported models

13 supported models. Run `pnpm run test:models` to verify against your account.

| Model                      |
| -------------------------- |
| claude-fable-5             |
| claude-haiku-4-5           |
| claude-haiku-4-5-20251001  |
| claude-opus-4-5            |
| claude-opus-4-5-20251101   |
| claude-opus-4-6            |
| claude-opus-4-7            |
| claude-opus-4-8            |
| claude-opus-5              |
| claude-sonnet-4-5          |
| claude-sonnet-4-5-20250929 |
| claude-sonnet-4-6          |
| claude-sonnet-5            |

## Credential sources

The plugin checks these in order:

1. macOS Keychain (all `Claude Code-credentials*` entries — multiple accounts are detected automatically)
2. `~/.claude/.credentials.json` (fallback, works on all platforms; if `CLAUDE_CONFIG_DIR` is set, reads `$CLAUDE_CONFIG_DIR/.credentials.json` instead)

## Multiple accounts (macOS)

If you have [multiple Claude Code accounts](https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2) authenticated on macOS, the plugin detects all of them from the Keychain automatically. Each account is labeled by its subscription tier (Claude Pro, Claude Max, etc.).

To switch accounts:

```bash
opencode auth login
```

Select "Switch Claude Code account" and pick the account you want to use. Your selection is persisted across sessions.

If only one account is found, the switcher is hidden and the plugin uses it directly.

## Troubleshooting

| Problem                                                | Solution                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Credentials not found"                                | Run `claude` to authenticate with Claude Code first                                                                                                                                                                                                                             |
| "Keychain is locked"                                   | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db`                                                                                                                                                                                                            |
| "Token expired and refresh failed"                     | The plugin runs `claude` CLI to refresh automatically. If this fails, re-authenticate manually by running `claude`                                                                                                                                                              |
| Not working on Linux/Windows                           | Ensure `~/.claude/.credentials.json` exists (or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set). Run `claude` to create it                                                                                                                                       |
| Keychain access denied                                 | Grant access when macOS prompts you                                                                                                                                                                                                                                             |
| Keychain read timed out                                | Restart Keychain Access (can happen on macOS Tahoe)                                                                                                                                                                                                                             |
| "Credentials are unavailable or expired"               | Run `claude` to refresh your Claude Code credentials                                                                                                                                                                                                                            |
| Credentials ignored, or `claude` runs on every request | `$CLAUDE_CONFIG_DIR/.credentials.json` needs `accessToken` and `refreshToken` as strings and `expiresAt` as **epoch milliseconds**. A hand-assembled file with `expiresAt: 0` reads as permanently expired and forces a refresh on every request. Check the container clock too |
| "`claude` could not refresh them"                      | The plugin refreshes by running the `claude` CLI. Check that `claude` works on this machine — it reaches `claude.ai` to refresh, which working `api.anthropic.com` access does not imply. `CLAUDE_AUTH_DEBUG=1` records the proxy/TLS environment and every refresh attempt.    |
| "Extra usage is required for long context requests"    | Your conversation exceeded 200k tokens. See [Long context (1M)](#long-context-1m) below                                                                                                                                                                                         |
| Plugin not updating to latest version                  | Delete the cached package: `rm -rf ~/.cache/opencode/packages/@y00njinuk/opencode-claude-auth@latest/` then restart OpenCode                                                                                                                                                    |

### Diagnostic logging

If you're hitting auth errors that are hard to reproduce, enable debug logging to capture the full auth flow:

```bash
export CLAUDE_AUTH_DEBUG=1
```

Restart OpenCode and reproduce the issue. The plugin writes structured JSON logs to `~/.local/share/opencode/claude-auth-debug.log`. All secrets (tokens, API keys) are automatically redacted — the log file is safe to paste into a GitHub issue.

To write logs to a custom path:

```bash
export CLAUDE_AUTH_DEBUG=/tmp/claude-auth-debug.log
```

Disable when done:

```bash
unset CLAUDE_AUTH_DEBUG
```

## Long context (1M)

1M token context is supported natively — the API no longer requires a beta flag for it, so the plugin doesn't send the legacy `context-1m-2025-08-07` header.

If your plan doesn't cover long context billing, requests beyond the standard window fail with "Extra usage is required for long context requests". When a long context error is caused by a beta flag (e.g. one added via `ANTHROPIC_BETA_FLAGS`), the plugin retries without the offending flag.

## Environment variable overrides

All configurable parameters can be overridden via environment variables. If Anthropic changes something before we publish an update, set an env var and keep working:

| Variable                                   | Description                                                                                                                                                                                                                                                                                  | Default                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ANTHROPIC_CLI_VERSION`                    | Claude CLI version for user-agent and billing headers                                                                                                                                                                                                                                        | `config.ccVersion` in [`src/model-config.ts`](src/model-config.ts) |
| `ANTHROPIC_USER_AGENT`                     | Full User-Agent string (overrides CLI version)                                                                                                                                                                                                                                               | `claude-cli/{version} (external, sdk-cli)`                         |
| `ANTHROPIC_BETA_FLAGS`                     | Comma-separated beta feature flags                                                                                                                                                                                                                                                           | `baseBetas` list in [`src/model-config.ts`](src/model-config.ts)   |
| `CLAUDE_CODE_ENTRYPOINT`                   | Entrypoint reported in the billing header. Set by Claude Code itself; an inherited value changes what the plugin sends, which is why this repo's tests run under `env -u CLAUDE_CODE_ENTRYPOINT`.                                                                                            | `sdk-cli`                                                          |
| `CLAUDE_AUTH_DEBUG`                        | Enable diagnostic logging (`1` for default path, or a custom file path)                                                                                                                                                                                                                      | disabled                                                           |
| `CLAUDE_CONFIG_DIR`                        | Claude Code config directory used for the credentials-file fallback (reads `$CLAUDE_CONFIG_DIR/.credentials.json`). macOS still checks the Keychain first.                                                                                                                                   | `~/.claude`                                                        |
| `OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS`        | Max ms the plugin waits when honouring a 429/529 `retry-after` header. Beyond this cap the response surfaces immediately so OpenCode doesn't appear to hang on hour-long quota resets.                                                                                                       | `30000`                                                            |
| `OPENCODE_CLAUDE_AUTH_TOOL_REPAIR`         | Strategy for reconciling `tool_use`/`tool_result` adjacency broken by OpenCode auto-compaction. `placeholder` synthesizes a paired result for orphaned `tool_use` blocks (lossless, preserves `thinking` blocks); `drop` removes orphaned blocks (omitting whole thinking turns).            | `placeholder`                                                      |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS` | TTL for the cross-process refresh lock. A held lock older than this is treated as stale (crashed holder) and taken over.                                                                                                                                                                     | `20000`                                                            |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR`    | Directory for the advisory cross-process refresh lock files.                                                                                                                                                                                                                                 | OpenCode data dir (`~/.local/share/opencode`)                      |
| `OPENCODE_CLAUDE_AUTH_CLI_TIMEOUT_MS`      | Per-attempt budget for the `claude` run that performs a refresh. Two attempts are made. Note this is a `SIGTERM` deadline, not a hard one. Invalid, zero or negative values use the default.                                                                                                 | `60000`                                                            |
| `OPENCODE_CLAUDE_AUTH_CLI_COOLDOWN_MS`     | How long a `claude` run that rotated nothing suppresses the next one for the same account. The run is a blocking `execSync` that freezes OpenCode for its duration, so this bounds the cost when the CLI cannot repair the account either. Invalid, zero or negative values use the default. | `60000`                                                            |

Example:

```bash
export ANTHROPIC_CLI_VERSION=2.2.0
```

## How it works (technical)

- Registers an `auth.loader` with a custom `fetch` that intercepts all Anthropic API requests
- Sets `Authorization: Bearer` with fresh OAuth tokens (cached in memory, 30s TTL, updated in-place after refresh)
- Translates tool names between OpenCode and Anthropic API formats (adds/strips `mcp_` prefix)
- Buffers SSE response streams at event boundaries for reliable tool name translation
- Injects Claude Code identity into system prompts via `experimental.chat.system.transform`
- Sets required API headers (beta flags, billing, user-agent) with model-aware selection
- On macOS, enumerates all `Claude Code-credentials*` Keychain entries and labels them by subscription tier
- Provides an account switcher via `opencode auth login` when multiple accounts are found; persists selection to `~/.local/share/opencode/claude-account-source.txt`
- Syncs credentials to `auth.json` on startup and every 5 minutes as a fallback. That tick only mirrors credentials that are already valid — it never refreshes, so it can never turn into a `claude` run on a timer
- On Windows, writes to both `%USERPROFILE%\.local\share\opencode\auth.json` and `%LOCALAPPDATA%\opencode\auth.json`
- Re-reads the credential source on every cache miss, so an account rotated by something other than this plugin — the `claude` CLI in another terminal, a second OpenCode instance, or a switcher like [claude-swap](https://github.com/realiti4/claude-swap) — gets picked up mid-session without a restart. Bounded by the same 30s cache, so it adds at most about two source reads a minute under load. A stored blob is adopted unconditionally: since this plugin never writes credentials, a disagreement between memory and the store can only mean the store is newer
- Retries API requests on 429 (rate limit) and 529 (overloaded) with exponential backoff, respecting `retry-after` headers
- On a 429 that outlives those backoff retries, re-reads the source once and retries only if the access token changed, so a rate limit another process has already resolved by switching accounts isn't surfaced. A changed token isn't proof of a switch — a routine refresh of the same account changes it too — so this costs at most one extra request
- On a 401, recovers in place rather than surfacing it: adopts an externally rotated token if the source now holds one, otherwise runs the `claude` CLI to force a refresh, then retries the request. Bounded at two attempts, so a rejected token costs at most three API calls. The forced refresh is cooldown-gated and only counts as success if the access token actually changed, so a 401 loop cannot become a spawn loop. A 401 that survives recovery is returned unmodified, without SSE stream transformation, since it carries an error body rather than a stream
- Refreshes by running the `claude` CLI, never by calling the OAuth token endpoint itself. The CLI owns the credential store and rotates and persists in one step, so this plugin never has to write credentials — and can never strand a rotated refresh token. Triggered only within 60 seconds of expiry, the point at which Claude Code will actually rotate; concurrent refreshes of one account share a single run, in-process and across processes, since each rotation invalidates the previous refresh token. See [Appendix: 토큰 정책](#appendix-토큰-정책-한글)
- If credentials aren't OAuth-based, the auth loader returns `{}` and falls through to API key auth
- If credentials are unavailable or unreadable, the plugin disables itself and OpenCode continues without Claude auth

## Appendix: 토큰 정책 (한글)

### 정책

**이 플러그인은 OAuth 토큰 엔드포인트를 직접 호출하지 않는다.**
토큰 갱신은 전적으로 `claude` CLI가 수행하고, 플러그인은 CLI가 자격증명 저장소에 쓴 것을 읽기만 한다.

- 플러그인은 자격증명을 저장소에 쓰지 않는다.
- 갱신은 만료 60초 이내에, 요청 경로에서만 일어난다.
- 백그라운드 타이머는 이미 유효한 자격증명을 `auth.json`에 미러링만 한다.
- 플러그인 init은 `claude`를 실행하지 않는다.

### 목적

- **차단된 망에서의 동작 보장.** API 요청은 `api.anthropic.com`으로, 토큰 갱신은 `claude.ai`로
  간다. 후자만 차단된 환경에서도 갱신이 가능해야 한다.
- **refresh token 유실 방지.** 갱신은 refresh token을 회전시키므로, 회전과 저장이 한 곳에서
  원자적으로 일어나야 한다.

이 정책을 코드에서 강제하기 위한 규약과 불변 조건은 [`CLAUDE.md`](CLAUDE.md)에 있다.
갱신 경로를 수정하기 전에 반드시 읽어야 한다.

## Disclaimer

This plugin uses Claude Code's OAuth credentials to authenticate with Anthropic's API. Anthropic's Terms of Service state that Claude Pro/Max subscription tokens should only be used with official Anthropic clients. This plugin exists as a community workaround and may stop working if Anthropic changes their OAuth infrastructure. Use at your own discretion.

## License

MIT
