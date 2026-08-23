/**
 * Credential resolution for the Anthropic auth provider.
 *
 * Refresh policy, deliberately: the plugin does NOT talk to the OAuth token
 * endpoint itself. When the active account's access token reaches the end of
 * its life, the `claude` CLI is run and whatever it wrote to the shared
 * credential store is read back. That is 2.0.0's policy, restored here on
 * purpose after 2.1.5-2.2.2 tried to own the exchange.
 *
 * Why the plugin does not refresh directly:
 *
 *   It cannot reliably reach the endpoint. `https://claude.ai/v1/oauth/token`
 *   is a consumer host, and corporate networks routinely block or
 *   TLS-intercept it while allowing `api.anthropic.com`, so the one request
 *   the refresh needs fails on a connection where every actual API request
 *   succeeds. OpenCode is a Bun single-file binary; the `claude` CLI is a
 *   separate Node process with its own proxy, CA and DNS handling, and it
 *   works on exactly the networks where the in-process `fetch` does not.
 *
 *   Owning the exchange meant owning its failures. 2.1.5 replaced 2.0.0's
 *   (accidentally broken) direct refresh with a real one; 2.1.6 then had to
 *   classify endpoint failures as transient or terminal, back off per account,
 *   lock across processes, and wait requests out through cooldowns — and got
 *   the classification wrong for every network-layer failure, which is the
 *   forever-loop this policy exists to end. None of that machinery has
 *   anything to classify or retry once the CLI owns the exchange.
 *
 *   It removes a whole class of unrecoverable failure. A successful refresh
 *   rotates the refresh token server-side, so whoever performs it must persist
 *   the result or the account is dead. When the plugin refreshed, a failed
 *   write-back (keychain ACL, compare-and-swap mismatch) silently stranded the
 *   rotated token in memory and left the store holding one the server had
 *   already invalidated — recoverable only by an interactive re-authentication,
 *   which is impossible on the networks this policy targets. The CLI rotates
 *   and persists in one step, as the owner of that store. This module never
 *   writes credentials.
 *
 * What that costs, stated plainly: a refresh is a `claude -p . --model haiku`
 * run, so it bills one small request and blocks the event loop for the length
 * of the spawn (execSync, measured ~5s on a healthy network). Token lifetime
 * is ~8-10h, so that is a handful of times a day. See CLI_REFRESH_COOLDOWN_MS
 * for the bound on how bad it gets when the CLI cannot fix things either.
 */
import { execSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  PRIMARY_SERVICE,
  readAllClaudeAccounts,
  refreshAccount,
  type ClaudeAccount,
  type ClaudeCredentials,
} from "./keychain.ts"
import { resetExcludedBetas } from "./betas.ts"
import { log } from "./logger.ts"
import { acquireRefreshLock } from "./refresh-lock.ts"

export type { ClaudeAccount } from "./keychain.ts"
export type { ClaudeCredentials } from "./keychain.ts"

/**
 * Where the `claude` CLI exchanges refresh tokens. Nothing in this module
 * calls it — that is the point of the policy above — but the request path
 * reports the host in its startup diagnostics, because "which host does the
 * refresh actually need" is the first question on a filtered network.
 */
export const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"

const CREDENTIAL_CACHE_TTL_MS = 30_000

/**
 * How close to expiry a token has to be before it is refreshed, and equally
 * the margin every read path requires of a stored blob before accepting it.
 * One constant because it is one rule: anything inside this window is a token
 * we would immediately have to refresh again.
 *
 * The `claude` CLI only rotates a token that is itself near expiry, so this is
 * also the only window in which running it accomplishes anything.
 */
const REFRESH_THRESHOLD_MS = 60_000

/** Per-attempt budget for the `claude` spawn (env-overridable). */
const CLI_REFRESH_TIMEOUT_MS = (() => {
  const raw = process.env.OPENCODE_CLAUDE_AUTH_CLI_TIMEOUT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000
})()

/**
 * How long a `claude` run that produced nothing suppresses the next one for
 * the same account (env-overridable).
 *
 * 2.0.0 had no such bound, and it needed one: the spawn is a synchronous
 * execSync that freezes the whole OpenCode process, the account cache is
 * dropped whenever resolution fails, and nothing else gates re-entry — so an
 * account the CLI cannot repair paid two 60s freezes on every single request,
 * forever. A minute of quiet costs nothing in recovery terms (a `claude` run
 * that could not produce a usable token will not produce one five seconds
 * later) and turns an unbounded freeze into a bounded one.
 */
const CLI_REFRESH_COOLDOWN_MS = (() => {
  const raw = process.env.OPENCODE_CLAUDE_AUTH_CLI_COOLDOWN_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000
})()

/**
 * TTL for the cross-process refresh lock, sized to the worst-case hold: two
 * CLI attempts plus margin. The lock is held across a blocking execSync and
 * therefore cannot be heartbeaten, so it has to be right up front.
 */
const REFRESH_LOCK_TTL_MS = CLI_REFRESH_TIMEOUT_MS * 2 + 15_000

const accountCacheMap = new Map<
  string,
  { creds: ClaudeCredentials; cachedAt: number }
>()

/**
 * In-process single-flight. Several requests reaching an expired token at once
 * must share one `claude` run, not queue up a spawn each.
 */
const inFlightRefreshes = new Map<string, Promise<ClaudeCredentials | null>>()

/** Per-source "no CLI run before this timestamp". See CLI_REFRESH_COOLDOWN_MS. */
const cliCooldowns = new Map<string, number>()

let activeAccountSource: string | null = null
let allAccounts: ClaudeAccount[] = []

export function initAccounts(accounts: ClaudeAccount[]): void {
  allAccounts = accounts
}

export function setActiveAccountSource(source: string): void {
  const previous = activeAccountSource
  activeAccountSource = source
  accountCacheMap.delete(source)
  resetExcludedBetas()
  if (previous && previous !== source) {
    log("account_switch", { newSource: source, previousSource: previous })
  }
}

export function refreshAccountsList(): ClaudeAccount[] {
  const fresh = readAllClaudeAccounts()
  if (fresh.length === 0 && allAccounts.length > 0) {
    // Transient empty read (e.g. keychain race while the claude CLI rewrites
    // credentials) must not clobber a working session.
    log("accounts_reload_empty", { keptAccounts: allAccounts.length })
    return allAccounts
  }
  allAccounts = fresh
  return allAccounts
}

export function getActiveAccount(): ClaudeAccount | null {
  if (allAccounts.length === 0) return null
  if (activeAccountSource) {
    const found = allAccounts.find((a) => a.source === activeAccountSource)
    if (found) return found
  }
  return allAccounts[0]
}

function getAccountStateFile(): string {
  return join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "claude-account-source.txt",
  )
}

export function loadPersistedAccountSource(): string | null {
  try {
    const path = getAccountStateFile()
    if (existsSync(path)) {
      return readFileSync(path, "utf-8").trim() || null
    }
  } catch {
    // ignore
  }
  return null
}

export function saveAccountSource(source: string): void {
  try {
    const path = getAccountStateFile()
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, source, "utf-8")
  } catch {
    // Non-fatal
  }
}

function getAuthJsonPaths(): string[] {
  const xdgPath = join(homedir(), ".local", "share", "opencode", "auth.json")
  if (process.platform === "win32") {
    const appData =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    const localAppDataPath = join(appData, "opencode", "auth.json")
    return [xdgPath, localAppDataPath]
  }
  return [xdgPath]
}

function syncToPath(authPath: string, creds: ClaudeCredentials): void {
  let auth: Record<string, unknown> = {}
  if (existsSync(authPath)) {
    const raw = readFileSync(authPath, "utf-8").trim()
    if (raw) {
      try {
        auth = JSON.parse(raw)
      } catch {
        // Malformed file, start fresh
      }
    }
  }
  auth.anthropic = {
    type: "oauth",
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt,
  }
  const dir = dirname(authPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  writeFileSync(authPath, JSON.stringify(auth, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  })
  if (process.platform !== "win32") {
    chmodSync(authPath, 0o600)
  }
}

export function syncAuthJson(creds: ClaudeCredentials): void {
  for (const authPath of getAuthJsonPaths()) {
    try {
      syncToPath(authPath, creds)
      log("sync_auth_json", { path: authPath, success: true })
    } catch (err) {
      log("sync_auth_json", {
        path: authPath,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
}

/**
 * Whether a stored blob has enough life left to be worth adopting.
 * See {@link REFRESH_THRESHOLD_MS}.
 */
function hasUsableLifetime(creds: ClaudeCredentials | null): boolean {
  return !!creds && creds.expiresAt > Date.now() + REFRESH_THRESHOLD_MS
}

/**
 * A per-account keychain service the `claude` CLI addresses through its own
 * CLAUDE_CONFIG_DIR, as opposed to the primary service every install has.
 */
function isSuffixedAccountSource(source: string): boolean {
  return source !== PRIMARY_SERVICE && source.startsWith(PRIMARY_SERVICE + "-")
}

/**
 * Environment for the `claude` child.
 *
 * Built explicitly rather than by spreading `process.env` wholesale, because
 * three inherited variables silently defeat the entire refresh. With
 * ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL set — all
 * plausible on a corporate network fronted by a gateway — `claude`
 * authenticates with the key, never touches the OAuth credential store, and
 * exits 0. The run then looks like a success, rotates nothing, and (before
 * CLI_REFRESH_COOLDOWN_MS existed) billed a request on every attempt forever.
 */
function cliChildEnv(configDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "dumb" }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_BASE_URL
  // Set by whichever Claude Code process launched OpenCode; leaving it in
  // makes the child report someone else's entrypoint.
  delete env.CLAUDE_CODE_ENTRYPOINT
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  return env
}

/**
 * Run the `claude` CLI so it refreshes its own credentials, which is how this
 * plugin refreshes: the CLI owns the credential store and rotates and persists
 * in one step. Returns whether a run exited cleanly — NOT whether anything was
 * rotated, which only a re-read of the store can tell.
 *
 * A suffixed account is skipped when its config directory is unknown, because
 * without CLAUDE_CONFIG_DIR the CLI would refresh the primary account instead.
 */
function refreshViaCli(configDir?: string, requireConfigDir = false): boolean {
  if (requireConfigDir && !configDir) {
    log("refresh_cli_skipped", {
      source: "cli",
      reason: "configDir unknown for suffixed account",
    })
    return false
  }

  const env = cliChildEnv(configDir)
  const maxAttempts = 2
  for (let i = 0; i < maxAttempts; i++) {
    log("refresh_started", { source: "cli", attempt: i + 1, configDir })
    try {
      execSync("claude -p . --model haiku", {
        timeout: CLI_REFRESH_TIMEOUT_MS,
        encoding: "utf-8",
        env,
        stdio: "ignore",
        cwd: tmpdir(),
      })
      log("refresh_success", { source: "cli" })
      return true
    } catch (err) {
      log("refresh_failed", {
        source: "cli",
        attempt: i + 1,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  log("refresh_cli_exhausted", { source: "cli", configDir })
  return false
}

/**
 * Read what a `claude` run wrote for this account.
 *
 * A suffixed account falls back to the primary service because the CLI writes
 * there whenever it could not be pointed at the account's own config
 * directory. Read errors are swallowed: a locked keychain is a reason to
 * report "no credentials", not to reject the caller's promise with an error it
 * has no branch for.
 */
function readRotatedCredentials(
  target: ClaudeAccount,
  isSuffixedAccount: boolean,
): ClaudeCredentials | null {
  let rotated: ClaudeCredentials | null = null
  try {
    rotated = refreshAccount(target.source, target.configDir)
  } catch {
    rotated = null
  }
  if (!hasUsableLifetime(rotated) && isSuffixedAccount) {
    try {
      const primary = refreshAccount(PRIMARY_SERVICE)
      if (hasUsableLifetime(primary)) rotated = primary
    } catch {
      // Keep whatever the account's own source gave us.
    }
  }
  return hasUsableLifetime(rotated) ? rotated : null
}

/**
 * How a caller wants a resolution performed, as opposed to what it wants
 * resolved. Only the CLI run needs saying, because it is the only step whose
 * cost is paid by something other than the caller: it freezes the whole
 * OpenCode process for the length of a subprocess.
 */
export interface CredentialResolveOptions {
  /**
   * Whether an expired token may be refreshed by running `claude`. Defaults to
   * true, which is right for a request: the request is already waiting and the
   * run is the only thing that can serve it.
   *
   * Plugin init passes false. Its call is awaited before OpenCode has a UI, so
   * a run there stalls the launch itself rather than one request — and on a
   * network where the CLI is the only working refresh path, an expired stored
   * token at startup is the normal case, not the exceptional one. Init already
   * treats a null result as "leave it to the request path".
   */
  allowCliRefresh?: boolean
}

/**
 * Bring the given (or active) account's credentials up to date.
 *
 * Returns usable credentials, or null when the account cannot be refreshed
 * right now. The whole of the refresh policy is here: pick up anything another
 * process already wrote, and if the token is genuinely at the end of its life,
 * run `claude` and read the store again.
 */
export async function refreshIfNeeded(
  account?: ClaudeAccount,
  opts: CredentialResolveOptions = {},
): Promise<ClaudeCredentials | null> {
  const target = account ?? getActiveAccount()
  if (!target) return null

  // Pick up credentials replaced externally — the claude CLI in another
  // terminal, a second OpenCode instance, an account switch. Bounded by
  // getCachedCredentials's 30s TTL, so it fires at most ~2x/min under load.
  //
  // A keychain read shells out to `security`, which throws when the keychain
  // is locked, access is denied, or the call times out. Degrade to the
  // in-memory credentials rather than take down the request path.
  //
  // Adopting unconditionally is safe here in a way it was not while this
  // module performed its own refreshes: nothing in this file writes to the
  // store, so a disagreement between memory and store can only mean the store
  // is newer. The elaborate "adopt only if usable, unless ours is also
  // unusable" guard that used to live here existed solely to avoid
  // re-adopting a blob our own failed write-back had orphaned.
  try {
    const stored = refreshAccount(target.source, target.configDir)
    if (stored) target.credentials = stored
  } catch (err) {
    log("source_reread_failed", {
      source: target.source,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const creds = target.credentials
  if (creds.expiresAt > Date.now() + REFRESH_THRESHOLD_MS) return creds

  if (opts.allowCliRefresh === false) {
    log("refresh_cli_skipped", {
      source: target.source,
      reason: "caller declined a CLI refresh",
    })
    return null
  }

  const cooldownUntil = cliCooldowns.get(target.source) ?? 0
  if (cooldownUntil > Date.now()) {
    log("refresh_cli_cooldown_skip", {
      source: target.source,
      until: cooldownUntil,
    })
    return null
  }

  // Share one run in-process...
  const inFlight = inFlightRefreshes.get(target.source)
  if (inFlight) {
    log("refresh_joined", { source: target.source })
    return inFlight
  }

  // ...and one across processes. This lock is the one piece of 2.1.x
  // single-flighting worth keeping, and it is worth more here than it was
  // there. A refresh rotates the refresh token server-side, so N `claude` runs
  // starting at once produce N rotations, and every one but the last is
  // invalidated the moment the next completes. On a network where interactive
  // re-authentication is impossible, losing the refresh token that way is the
  // one failure with no recovery — cheap at the price of a lock file. If
  // another process holds it, it is already doing this work: let it, and read
  // what it writes on the next pass rather than spawning a second `claude`.
  const lock = acquireRefreshLock(target.source, { ttlMs: REFRESH_LOCK_TTL_MS })
  if (!lock) {
    log("refresh_lock_busy", { source: target.source })
    return null
  }

  const pending = (async () => {
    try {
      return performCliRefresh(target)
    } finally {
      lock.release()
    }
  })()
  inFlightRefreshes.set(target.source, pending)
  try {
    return await pending
  } finally {
    inFlightRefreshes.delete(target.source)
  }
}

/**
 * Run `claude` for this account and adopt whatever it rotated.
 *
 * The cooldown is armed before the run, not after: the run blocks the event
 * loop for up to two full timeouts, so a deadline computed afterwards would
 * already have been outlived by the call it exists to gate. Arming it up front
 * also covers the runs that never happen — an account whose config directory
 * we cannot name will not become nameable inside the window either.
 *
 * The store is read whether or not the run exited cleanly. `claude` is killed
 * at its timeout by SIGTERM, and a run killed that way may well have completed
 * its refresh and written the rotated blob seconds earlier, with only a
 * trailing API call running long. Throwing that away would discard a rotation
 * already paid for.
 *
 * Success is "the access token changed", not "the store holds something
 * usable". The two coincide on the expiry path, where what we held was expired
 * by definition — but not on the 401 path, which runs against a token that
 * still looks perfectly valid locally. Reading back the same token there means
 * the run accomplished nothing, and treating it as success would clear the
 * cooldown and let the next 401 spawn `claude` again, turning a rejected-token
 * loop into a spawn loop.
 */
function performCliRefresh(target: ClaudeAccount): ClaudeCredentials | null {
  cliCooldowns.set(target.source, Date.now() + CLI_REFRESH_COOLDOWN_MS)

  const before = target.credentials.accessToken
  log("refresh_needed", {
    source: target.source,
    expiresAt: target.credentials.expiresAt,
    expiresIn: target.credentials.expiresAt - Date.now(),
  })

  const isSuffixedAccount = isSuffixedAccountSource(target.source)
  const exitedCleanly = refreshViaCli(target.configDir, isSuffixedAccount)
  const rotated = readRotatedCredentials(target, isSuffixedAccount)

  if (!rotated || rotated.accessToken === before) {
    log("refresh_exhausted", {
      source: target.source,
      exitedCleanly,
      reason: rotated ? "token unchanged" : "no usable credentials",
    })
    return null
  }

  target.credentials = rotated
  cliCooldowns.delete(target.source)
  log("refresh_adopted_from_cli", { source: target.source, exitedCleanly })
  return rotated
}

/**
 * The active account's credentials for auth.json sync purposes. Unlike
 * getCachedCredentials this never triggers a refresh — the background timer
 * mirrors what is already valid and nothing more, so it can never turn into a
 * `claude` run on a 5-minute schedule.
 */
export function getCredentialsForSync(): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account) return null
  return hasUsableLifetime(account.credentials) ? account.credentials : null
}

/**
 * Re-read only the active account's credentials from its source, so an
 * externally refreshed token is picked up without a full multi-account
 * keychain rescan.
 */
export function reloadActiveAccount(): void {
  const account = getActiveAccount()
  if (!account) return
  try {
    const fresh = refreshAccount(account.source, account.configDir)
    if (fresh) account.credentials = fresh
  } catch (err) {
    log("account_reload_failed", {
      source: account.source,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Force a refresh of the active account even though its credentials still look
 * valid locally. Used on a 401 when the store still holds the token the API
 * just rejected — revoked, or rotated somewhere we have not read yet.
 *
 * Bypasses the expiry check (the token looks fine; the API disagrees) but not
 * the cooldown, because a 401 loop must not become a `claude` loop.
 */
export async function forceRefreshActiveAccount(): Promise<ClaudeCredentials | null> {
  const account = getActiveAccount()
  if (!account) return null

  const cooldownUntil = cliCooldowns.get(account.source) ?? 0
  if (cooldownUntil > Date.now()) {
    log("force_refresh_cooldown_skip", {
      source: account.source,
      until: cooldownUntil,
    })
    return null
  }

  // performCliRefresh already requires the access token to change, which is
  // exactly the condition this path cares about: the API rejected the token we
  // hold, so anything that hands back the same one has not helped.
  const refreshed = performCliRefresh(account)
  if (!refreshed) {
    log("force_refresh_failed", { source: account.source })
    return null
  }

  accountCacheMap.set(account.source, {
    creds: refreshed,
    cachedAt: Date.now(),
  })
  return refreshed
}

/**
 * Drop the active account's cached credentials so the next
 * getCachedCredentials() call re-reads from the source, bypassing the 30s TTL.
 * Used when the API rejects a token (401) that still looks valid locally.
 */
export function invalidateCredentialCache(): void {
  const account = getActiveAccount()
  if (account) {
    accountCacheMap.delete(account.source)
    log("cache_invalidated", { source: account.source })
  }
}

export async function getCachedCredentials(
  opts: CredentialResolveOptions = {},
): Promise<ClaudeCredentials | null> {
  const account = getActiveAccount()
  if (!account) return null

  const now = Date.now()
  const cached = accountCacheMap.get(account.source)
  if (
    cached &&
    now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS &&
    cached.creds.expiresAt > now + REFRESH_THRESHOLD_MS
  ) {
    log("cache_hit", {
      source: account.source,
      ttlRemaining: CREDENTIAL_CACHE_TTL_MS - (now - cached.cachedAt),
    })
    return cached.creds
  }

  log("cache_miss", {
    source: account.source,
    reason: cached ? "stale or expiring" : "empty",
  })

  const fresh = await refreshIfNeeded(account, opts)
  if (!fresh) {
    log("credentials_unavailable", { source: account.source })
    accountCacheMap.delete(account.source)
    return null
  }

  accountCacheMap.set(account.source, { creds: fresh, cachedAt: Date.now() })
  return fresh
}

/**
 * Re-read the active account's source and adopt the result if it is usable.
 * The 401 recovery path's cheapest option: another process may already have
 * rotated the token the API just rejected.
 */
export function reloadCredentialsFromSource(): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account) return null

  let reloaded: ClaudeCredentials | null
  try {
    reloaded = refreshAccount(account.source, account.configDir)
  } catch {
    accountCacheMap.delete(account.source)
    log("credentials_source_reload", {
      source: account.source,
      success: false,
      reason: "read_error",
    })
    return null
  }
  if (
    !reloaded ||
    !reloaded.accessToken.trim() ||
    !hasUsableLifetime(reloaded)
  ) {
    accountCacheMap.delete(account.source)
    log("credentials_source_reload", {
      source: account.source,
      success: false,
      reason: !reloaded
        ? "unavailable"
        : !reloaded.accessToken.trim()
          ? "invalid"
          : "expiring",
    })
    return null
  }

  account.credentials = reloaded
  accountCacheMap.set(account.source, { creds: reloaded, cachedAt: Date.now() })
  log("credentials_source_reload", {
    source: account.source,
    success: true,
  })
  return reloaded
}

/** Test seam: drop all per-source refresh and cache state. */
export function resetRefreshState(): void {
  cliCooldowns.clear()
  inFlightRefreshes.clear()
  accountCacheMap.clear()
}
