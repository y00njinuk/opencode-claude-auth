/**
 * Transient-vs-terminal classification and per-account backoff for OAuth token
 * refreshes.
 *
 * The token endpoint (`claude.ai/v1/oauth/token`) rate-limits refresh requests
 * with HTTP 429 `rate_limit_error`. That is transient — the refresh token is
 * still valid — but the plugin previously treated every non-OK refresh as a
 * hard failure, surfacing "credentials unavailable. Run `claude`" and then
 * hammering the same endpoint (and the `claude` CLI, which hits it too). This
 * module lets callers tell a transient rate-limit apart from a genuinely dead
 * refresh token (`invalid_grant`), and imposes a cooldown so a rate-limited
 * account is not re-hit until the window has plausibly cleared.
 */

export type RefreshFailureKind = "transient" | "terminal"

/** Base cooldown after the first transient failure (env-overridable). */
export const BASE_COOLDOWN_MS = (() => {
  const raw = process.env.OPENCODE_CLAUDE_AUTH_REFRESH_COOLDOWN_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000
})()

/** Hard ceiling for a single cooldown, regardless of consecutive failures. */
export const MAX_COOLDOWN_MS = 60_000

/**
 * OAuth token-endpoint error codes that mean the refresh token itself is no
 * longer usable. Everything else — rate limits, 5xx, network errors, unknown
 * codes — is treated as transient so a recoverable blip never surfaces as a
 * hard "re-authenticate" error.
 */
const TERMINAL_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
])

export function classifyRefreshFailure(
  _status: number,
  oauthError?: string,
): RefreshFailureKind {
  return oauthError && TERMINAL_OAUTH_ERRORS.has(oauthError)
    ? "terminal"
    : "transient"
}

interface BackoffOptions {
  retryAfterMs?: number
  now?: number
  rng?: () => number
  /** HTTP status from the token endpoint; 0 when the request never got one. */
  status?: number
  /** OAuth error code from the endpoint's body, when it sent one. */
  oauthError?: string
}

/**
 * Delay before the next refresh attempt. An explicit `retry-after` from the
 * endpoint wins (still clamped to `MAX_COOLDOWN_MS`); otherwise an exponential
 * schedule (base · 2^(n-1),
 * capped) with jitter in the [50%, 100%] band to desynchronize the several
 * OpenCode instances / CLI invocations that all refresh the same account.
 */
export function computeBackoffMs(
  consecutive: number,
  opts: BackoffOptions = {},
): number {
  if (opts.retryAfterMs !== undefined && opts.retryAfterMs > 0) {
    // Honor the server's hint, but keep it under the documented cap so a large
    // `Retry-After` (e.g. an hour-long quota reset) can't pin every request to
    // the full wait budget for that whole window.
    return Math.min(MAX_COOLDOWN_MS, opts.retryAfterMs)
  }
  const rng = opts.rng ?? Math.random
  const exponent = Math.max(0, consecutive - 1)
  const scheduled = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** exponent)
  const jitterFactor = 0.5 + rng() * 0.5
  return Math.min(MAX_COOLDOWN_MS, Math.round(scheduled * jitterFactor))
}

interface CooldownState {
  until: number
  consecutive: number
}

const cooldowns = new Map<string, CooldownState>()
const lastFailureKind = new Map<string, RefreshFailureKind>()
const lastFailureDetail = new Map<string, RefreshFailureDetail>()

/**
 * Why the last refresh for an account failed, kept so the request path can
 * tell the user what actually went wrong. `status` is the HTTP status from
 * the token endpoint, or `0` when the request never produced one (DNS
 * failure, TLS error, proxy block, connection reset, or the 15s timeout
 * aborting it).
 */
export interface RefreshFailureDetail {
  kind: RefreshFailureKind
  status: number
  oauthError?: string
}

/**
 * One human-readable clause naming the actual failure, for the message the
 * request path surfaces. Everything non-terminal used to be reported as
 * "rate-limited", which sent people looking for a quota problem when the
 * token endpoint was simply unreachable.
 */
export function describeRefreshFailure(
  detail: RefreshFailureDetail | null,
): string {
  if (!detail) return "Claude token refresh failed"
  if (detail.kind === "terminal") {
    return `Claude refresh token was rejected (${detail.oauthError ?? `HTTP ${detail.status}`})`
  }
  if (detail.status === 429) return "Claude token refresh is rate-limited"
  if (detail.status === 0) {
    return "Claude token endpoint unreachable (network error or timeout)"
  }
  if (detail.status >= 500) {
    return `Claude token endpoint returned HTTP ${detail.status}`
  }
  const why = detail.oauthError ? `, ${detail.oauthError}` : ""
  return `Claude token refresh failed (HTTP ${detail.status}${why})`
}

/**
 * Record a transient refresh failure for `source` and return the cooldown
 * duration applied. The cooldown escalates with consecutive transient
 * failures and is exposed via {@link isRefreshCooldownActive}.
 */
export function noteRefreshTransient(
  source: string,
  opts: BackoffOptions = {},
): number {
  const now = opts.now ?? Date.now()
  const consecutive = (cooldowns.get(source)?.consecutive ?? 0) + 1
  const ms = computeBackoffMs(consecutive, opts)
  cooldowns.set(source, { until: now + ms, consecutive })
  lastFailureKind.set(source, "transient")
  lastFailureDetail.set(source, {
    kind: "transient",
    status: opts.status ?? 0,
    oauthError: opts.oauthError,
  })
  return ms
}

/** Record a terminal refresh failure (dead refresh token). No cooldown. */
export function noteRefreshTerminal(
  source: string,
  detail: { status?: number; oauthError?: string } = {},
): void {
  cooldowns.delete(source)
  lastFailureKind.set(source, "terminal")
  lastFailureDetail.set(source, {
    kind: "terminal",
    status: detail.status ?? 0,
    oauthError: detail.oauthError,
  })
}

/** Clear all backoff state for `source` after a successful refresh/adopt. */
export function clearRefreshOutcome(source: string): void {
  cooldowns.delete(source)
  lastFailureKind.delete(source)
  lastFailureDetail.delete(source)
}

export function isRefreshCooldownActive(
  source: string,
  now: number = Date.now(),
): boolean {
  const state = cooldowns.get(source)
  return state !== undefined && state.until > now
}

export function getRefreshCooldownUntil(source: string): number | null {
  return cooldowns.get(source)?.until ?? null
}

export function getRefreshFailureKind(
  source: string,
): RefreshFailureKind | null {
  return lastFailureKind.get(source) ?? null
}

export function getRefreshFailureDetail(
  source: string,
): RefreshFailureDetail | null {
  return lastFailureDetail.get(source) ?? null
}

/** Test seam: drop all in-memory backoff state. */
export function resetRefreshBackoffState(): void {
  cooldowns.clear()
  lastFailureKind.clear()
  lastFailureDetail.clear()
}
