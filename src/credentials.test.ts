import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OAUTH_TOKEN_URL } from "./credentials.ts"
import { acquireRefreshLock } from "./refresh-lock.ts"
import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// Keep the cross-process refresh lock off the real OpenCode data dir during
// tests, and isolated to this test process.
process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR = mkdtempSync(
  join(tmpdir(), "opencode-claude-auth-locktest-"),
)

type Creds = {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

// The refresh policy is "run `claude`, then read the store" — this module must
// never reach the network itself. Fail closed so any regression that
// reintroduces a direct token-endpoint call shows up as a test failure rather
// than as a real request.
globalThis.fetch = (async () => {
  throw new Error("network disabled in test harness")
}) as typeof fetch

interface CredentialsModule {
  getCachedCredentials: (opts?: {
    allowCliRefresh?: boolean
  }) => Promise<Creds | null>
  refreshIfNeeded: (
    account?: unknown,
    opts?: { allowCliRefresh?: boolean },
  ) => Promise<Creds | null>
  reloadCredentialsFromSource: () => Creds | null
  getCredentialsForSync: () => Creds | null
  forceRefreshActiveAccount: () => Promise<Creds | null>
  initAccounts: (accounts: unknown[]) => void
  invalidateCredentialCache: () => void
  refreshAccountsList: () => unknown[]
  reloadActiveAccount: () => void
  resetRefreshState: () => void
  syncAuthJson: (creds: Creds) => void
}

interface KeychainModule {
  __getReadCount: () => number
  __getWriteCount: () => number
  __setCredentials: (c: Creds | null) => void
  __setCredentialsForSource: (source: string, c: Creds | null) => void
  __setAccounts: (list: unknown[]) => void
  __setReadError: (enabled: boolean) => void
  __getReads: () => Array<{ source: string; configDir?: string }>
}

interface ChildProcessModule {
  __getExecSyncCount: () => number
  __getExecSyncCalls: () => Array<{
    command: string
    options?: {
      env?: Record<string, string | undefined>
      timeout?: number
      cwd?: string
    }
  }>
  __setExecSyncImpl: (
    impl: ((command: string, options?: unknown) => string) | null,
  ) => void
}

interface LockModule {
  __getAcquires: () => Array<{ source: string; ttlMs?: number }>
  __setGrant: (grant: boolean) => void
}

interface LoggerModule {
  __getLogs: () => Array<{ event: string; data?: Record<string, unknown> }>
}

/**
 * Load a private copy of credentials.ts with its dependencies stubbed.
 *
 * Every call clones the sources into a fresh temp directory, so each test gets
 * its own module instance: module-scope state (caches, cooldowns, in-flight
 * map) and env-derived constants are isolated. Environment variables the
 * module reads at import time must therefore be set BEFORE calling this.
 */
async function loadCredentials(initialExpiresAt: number): Promise<{
  credentialsModule: CredentialsModule
  keychainModule: KeychainModule
  childProcessModule: ChildProcessModule
  lockModule: LockModule
  loggerModule: LoggerModule
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-creds-"))
  const tempCredentials = join(tempDir, "credentials.ts")

  const sourceCredentials = await readFile(
    new URL("./credentials.ts", import.meta.url),
    "utf8",
  )
  const rewritten = sourceCredentials.replace(
    'import { execSync } from "node:child_process"',
    'import { execSync } from "./child-process.ts"',
  )

  // String.replace is a silent no-op on a miss, so reformatting credentials.ts's
  // child_process import would quietly leave the temp module importing the real
  // one — and every test that reaches refreshViaCli would then run
  // `claude -p . --model haiku` for real, twice, with a 60s timeout each, on a
  // developer machine where that rotates their actual token. Fail loudly here
  // instead. Fixing this means updating BOTH this rewrite and the identical one
  // in index.test.ts.
  if (!rewritten.includes('import { execSync } from "./child-process.ts"')) {
    throw new Error(
      "credentials.ts's child_process import no longer matches the test harness rewrite; " +
        "update the .replace() above (and its twin in index.test.ts) before running these tests",
    )
  }

  await writeFile(
    join(tempDir, "logger.ts"),
    `const logs = []
export function log(event, data) { logs.push({ event, data }) }
export function __getLogs() { return logs }
export function initLogger() {}
export function closeLogger() {}
`,
    "utf8",
  )

  // The `claude` spawn is stubbed, never real: a real one would run
  // `claude -p . --model haiku` on the developer's machine and rotate their
  // actual token. __setExecSyncImpl lets a test act out what a real run does to
  // the store (write a rotated blob, then be killed at its deadline) without
  // any of that. __getExecSyncCalls records the command and options — including
  // the env — so the environment handed to the child is assertable.
  await writeFile(
    join(tempDir, "child-process.ts"),
    `let execSyncCount = 0
const execSyncCalls = []
let execSyncImpl = null
export function execSync(command, options) {
  execSyncCount += 1
  execSyncCalls.push({ command, options })
  if (execSyncImpl) return execSyncImpl(command, options)
  return ""
}
export function __getExecSyncCount() { return execSyncCount }
export function __getExecSyncCalls() { return execSyncCalls }
export function __setExecSyncImpl(impl) { execSyncImpl = impl }
`,
    "utf8",
  )

  await writeFile(
    join(tempDir, "keychain.ts"),
    `let readCount = 0
let writeCount = 0
const reads = []
let accounts = null // null = derive a single account from the credentials var
let readError = false
let credentials = {
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: ${initialExpiresAt}
}
const bySource = {}

export const PRIMARY_SERVICE = "Claude Code-credentials"

export function readAllClaudeAccounts() {
  readCount += 1
  if (accounts !== null) return accounts
  return [{ label: "Account 1", source: "keychain", credentials }]
}

export function refreshAccount(source, configDir) {
  readCount += 1
  reads.push({ source, configDir })
  if (readError) throw new Error("Keychain read denied")
  if (Object.prototype.hasOwnProperty.call(bySource, source)) {
    return bySource[source]
  }
  return credentials
}

// credentials.ts no longer imports this: the CLI owns rotation and
// persistence. Kept so a regression that reintroduces a write shows up as a
// non-zero __getWriteCount rather than an import error.
export function writeBackCredentials(source, creds) {
  writeCount += 1
  return true
}

export function __setReadError(enabled) { readError = enabled }
export function __getReads() { return reads }
export function __getReadCount() { return readCount }
export function __getWriteCount() { return writeCount }
export function __setCredentials(c) { credentials = c }
export function __setCredentialsForSource(source, c) { bySource[source] = c }
export function __setAccounts(list) { accounts = list }
`,
    "utf8",
  )

  // Records what TTL the caller sized the lock for, and can refuse to grant so
  // the "another process is already refreshing" branch is reachable.
  await writeFile(
    join(tempDir, "refresh-lock.ts"),
    `const acquires = []
let grant = true
export function acquireRefreshLock(source, opts) {
  acquires.push({ source, ttlMs: opts && opts.ttlMs })
  if (!grant) return null
  return { release() {} }
}
export function __getAcquires() { return acquires }
export function __setGrant(v) { grant = v }
`,
    "utf8",
  )

  await writeFile(
    join(tempDir, "betas.ts"),
    `export function resetExcludedBetas() {}\n`,
    "utf8",
  )
  await writeFile(tempCredentials, rewritten, "utf8")

  const [credentialsModule, keychainModule, childProcessModule, lockModule] =
    await Promise.all([
      import(pathToFileURL(tempCredentials).href),
      import(pathToFileURL(join(tempDir, "keychain.ts")).href),
      import(pathToFileURL(join(tempDir, "child-process.ts")).href),
      import(pathToFileURL(join(tempDir, "refresh-lock.ts")).href),
    ])
  const loggerModule = await import(
    pathToFileURL(join(tempDir, "logger.ts")).href
  )

  return {
    credentialsModule: credentialsModule as CredentialsModule,
    keychainModule: keychainModule as KeychainModule,
    childProcessModule: childProcessModule as ChildProcessModule,
    lockModule: lockModule as LockModule,
    loggerModule: loggerModule as LoggerModule,
  }
}

const HOUR = 60 * 60 * 1000

function account(expiresAt: number, over: Record<string, unknown> = {}) {
  return {
    label: "Account 1",
    source: "keychain",
    credentials: {
      accessToken: "token",
      refreshToken: "refresh",
      expiresAt,
    },
    ...over,
  }
}

function events(logger: LoggerModule): string[] {
  return logger.__getLogs().map((l) => l.event)
}

/**
 * Make the stubbed `claude` run do what a real one does: rotate the store.
 * Pre-seeding the store instead would be a different scenario — the up-front
 * source re-read would adopt it and no run would happen at all.
 */
function rotateOnRun(
  childProcessModule: ChildProcessModule,
  keychainModule: KeychainModule,
  creds: Creds,
  then?: () => void,
): void {
  childProcessModule.__setExecSyncImpl(() => {
    keychainModule.__setCredentials(creds)
    if (then) then()
    return ""
  })
}

describe("refresh policy: the claude CLI owns the exchange", () => {
  it("never calls the OAuth token endpoint itself", async () => {
    // globalThis.fetch throws in this harness. A refresh that reached the
    // network would surface as that error rather than as credentials.
    const now = Date.now()
    const { credentialsModule, childProcessModule, keychainModule } =
      await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])
    rotateOnRun(childProcessModule, keychainModule, {
      accessToken: "rotated",
      refreshToken: "refresh2",
      expiresAt: now + 10 * HOUR,
    })

    const creds = await credentialsModule.getCachedCredentials()

    assert.equal(creds?.accessToken, "rotated")
    assert.equal(childProcessModule.__getExecSyncCount(), 1)
  })

  it("never writes credentials back to the store", async () => {
    // The CLI rotates and persists in one step, as the owner of the store.
    // A write from here is how a rotated refresh token used to get stranded in
    // memory while the store kept one the server had already invalidated.
    const now = Date.now()
    const { credentialsModule, keychainModule, childProcessModule } =
      await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])
    rotateOnRun(childProcessModule, keychainModule, {
      accessToken: "rotated",
      refreshToken: "refresh2",
      expiresAt: now + 10 * HOUR,
    })

    await credentialsModule.getCachedCredentials()

    assert.equal(keychainModule.__getWriteCount(), 0)
  })

  it("runs `claude -p . --model haiku` from a temp cwd with a timeout", async () => {
    const now = Date.now()
    const { credentialsModule, childProcessModule, keychainModule } =
      await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])
    rotateOnRun(childProcessModule, keychainModule, {
      accessToken: "rotated",
      refreshToken: "refresh2",
      expiresAt: now + 10 * HOUR,
    })

    await credentialsModule.getCachedCredentials()

    const call = childProcessModule.__getExecSyncCalls()[0]
    assert.equal(call.command, "claude -p . --model haiku")
    assert.equal(call.options?.timeout, 60_000)
    assert.equal(call.options?.env?.TERM, "dumb")
    assert.ok(call.options?.cwd, "runs outside the user's project directory")
  })

  it("keeps API-key and base-URL variables out of the child environment", async () => {
    // With any of these set, `claude` authenticates with the key, never touches
    // the OAuth store, and exits 0 — a run that looks like success and rotates
    // nothing.
    const saved = {
      key: process.env.ANTHROPIC_API_KEY,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
      base: process.env.ANTHROPIC_BASE_URL,
    }
    process.env.ANTHROPIC_API_KEY = "sk-should-not-reach-the-child"
    process.env.ANTHROPIC_AUTH_TOKEN = "should-not-reach-the-child"
    process.env.ANTHROPIC_BASE_URL = "https://gateway.corp.example"
    try {
      const now = Date.now()
      const { credentialsModule, childProcessModule } = await loadCredentials(
        now - 1_000,
      )
      credentialsModule.initAccounts([account(now - 1_000)])

      await credentialsModule.getCachedCredentials()

      const env = childProcessModule.__getExecSyncCalls()[0].options?.env ?? {}
      assert.equal(env.ANTHROPIC_API_KEY, undefined)
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
      assert.equal(env.ANTHROPIC_BASE_URL, undefined)
      assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined)
    } finally {
      process.env.ANTHROPIC_API_KEY = saved.key
      process.env.ANTHROPIC_AUTH_TOKEN = saved.token
      process.env.ANTHROPIC_BASE_URL = saved.base
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY
      if (saved.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
      if (saved.base === undefined) delete process.env.ANTHROPIC_BASE_URL
    }
  })

  it("adopts a rotation written by a run that was killed at its deadline", async () => {
    // execSync's timeout is a SIGTERM, so a killed `claude` may well have
    // finished its refresh and written the rotated blob seconds earlier, with
    // only a trailing API call running long. That rotation is already paid for.
    const now = Date.now()
    const { credentialsModule, childProcessModule, keychainModule } =
      await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])
    childProcessModule.__setExecSyncImpl(() => {
      keychainModule.__setCredentials({
        accessToken: "rotated-before-kill",
        refreshToken: "refresh2",
        expiresAt: now + 10 * HOUR,
      })
      throw new Error("ETIMEDOUT")
    })

    const creds = await credentialsModule.getCachedCredentials()

    assert.equal(creds?.accessToken, "rotated-before-kill")
  })

  it("reports no credentials when the run rotates nothing", async () => {
    const now = Date.now()
    const { credentialsModule, loggerModule } = await loadCredentials(
      now - 1_000,
    )
    credentialsModule.initAccounts([account(now - 1_000)])

    const creds = await credentialsModule.getCachedCredentials()

    assert.equal(creds, null)
    assert.ok(events(loggerModule).includes("refresh_exhausted"))
  })
})

describe("refresh is only attempted inside the expiry window", () => {
  it("serves a token that is comfortably valid without running anything", async () => {
    const now = Date.now()
    const { credentialsModule, childProcessModule } = await loadCredentials(
      now + 10 * HOUR,
    )
    credentialsModule.initAccounts([account(now + 10 * HOUR)])

    const creds = await credentialsModule.getCachedCredentials()

    assert.ok(creds)
    assert.equal(childProcessModule.__getExecSyncCount(), 0)
  })

  it("refreshes a token inside the 60s window", async () => {
    const now = Date.now()
    const { credentialsModule, childProcessModule, keychainModule } =
      await loadCredentials(now + 30_000)
    credentialsModule.initAccounts([account(now + 30_000)])
    rotateOnRun(childProcessModule, keychainModule, {
      accessToken: "rotated",
      refreshToken: "refresh2",
      expiresAt: now + 10 * HOUR,
    })

    await credentialsModule.getCachedCredentials()

    assert.equal(childProcessModule.__getExecSyncCount(), 1)
  })

  it("adopts a token another process already rotated, without running anything", async () => {
    const now = Date.now()
    const { credentialsModule, childProcessModule, keychainModule } =
      await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])
    // A sibling OpenCode instance or a `claude` in another terminal got there
    // first; the up-front source re-read must pick that up.
    keychainModule.__setCredentials({
      accessToken: "someone-elses-rotation",
      refreshToken: "refresh2",
      expiresAt: now + 10 * HOUR,
    })

    const creds = await credentialsModule.getCachedCredentials()

    assert.equal(creds?.accessToken, "someone-elses-rotation")
    assert.equal(childProcessModule.__getExecSyncCount(), 0)
  })

  it("degrades to in-memory credentials when the keychain read throws", async () => {
    const now = Date.now()
    const { credentialsModule, childProcessModule, keychainModule } =
      await loadCredentials(now + 10 * HOUR)
    credentialsModule.initAccounts([account(now + 10 * HOUR)])
    keychainModule.__setReadError(true)

    const creds = await credentialsModule.getCachedCredentials()

    assert.ok(creds, "a locked keychain must not take down the request path")
    assert.equal(childProcessModule.__getExecSyncCount(), 0)
  })
})

describe("the CLI run is bounded", () => {
  it("suppresses a second run inside the cooldown window", async () => {
    // The spawn is a synchronous execSync that freezes the whole process, and
    // a failed resolution drops the account cache, so without this an account
    // the CLI cannot repair pays the freeze on every single request.
    const now = Date.now()
    const { credentialsModule, childProcessModule } = await loadCredentials(
      now - 1_000,
    )
    credentialsModule.initAccounts([account(now - 1_000)])

    assert.equal(await credentialsModule.getCachedCredentials(), null)
    assert.equal(await credentialsModule.getCachedCredentials(), null)
    assert.equal(await credentialsModule.getCachedCredentials(), null)

    assert.equal(childProcessModule.__getExecSyncCount(), 1)
  })

  it("arms the cooldown before the run, not after", async () => {
    // A deadline computed after the call would already have been outlived by
    // the very call it exists to gate.
    const now = Date.now()
    const { credentialsModule, childProcessModule, loggerModule } =
      await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])
    childProcessModule.__setExecSyncImpl(() => {
      throw new Error("ETIMEDOUT")
    })

    await credentialsModule.getCachedCredentials()
    await credentialsModule.getCachedCredentials()

    // One run, both of its attempts; the second resolution never gets a run.
    assert.equal(childProcessModule.__getExecSyncCount(), 2)
    assert.ok(events(loggerModule).includes("refresh_cli_cooldown_skip"))
  })

  it("clears the cooldown once a run produces credentials", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule, childProcessModule } =
      await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])
    rotateOnRun(childProcessModule, keychainModule, {
      accessToken: "rotated",
      refreshToken: "refresh2",
      expiresAt: now + 10 * HOUR,
    })

    assert.ok(await credentialsModule.getCachedCredentials())

    // Expire again; a fresh run must be allowed rather than blocked by the
    // cooldown the successful run armed.
    childProcessModule.__setExecSyncImpl(null)
    keychainModule.__setCredentials({
      accessToken: "rotated",
      refreshToken: "refresh2",
      expiresAt: now - 1_000,
    })
    credentialsModule.invalidateCredentialCache()
    await credentialsModule.getCachedCredentials()

    // One run each side: the cooldown the successful run armed was cleared, so
    // the second expiry was allowed a run of its own rather than skipped.
    assert.equal(childProcessModule.__getExecSyncCount(), 2)
  })

  it("honours OPENCODE_CLAUDE_AUTH_CLI_COOLDOWN_MS", async () => {
    const saved = process.env.OPENCODE_CLAUDE_AUTH_CLI_COOLDOWN_MS
    process.env.OPENCODE_CLAUDE_AUTH_CLI_COOLDOWN_MS = "1"
    try {
      const now = Date.now()
      const { credentialsModule, childProcessModule } = await loadCredentials(
        now - 1_000,
      )
      credentialsModule.initAccounts([account(now - 1_000)])

      await credentialsModule.getCachedCredentials()
      await new Promise((r) => setTimeout(r, 5))
      await credentialsModule.getCachedCredentials()

      assert.equal(childProcessModule.__getExecSyncCount(), 2)
    } finally {
      if (saved === undefined) {
        delete process.env.OPENCODE_CLAUDE_AUTH_CLI_COOLDOWN_MS
      } else {
        process.env.OPENCODE_CLAUDE_AUTH_CLI_COOLDOWN_MS = saved
      }
    }
  })

  it("honours OPENCODE_CLAUDE_AUTH_CLI_TIMEOUT_MS", async () => {
    const saved = process.env.OPENCODE_CLAUDE_AUTH_CLI_TIMEOUT_MS
    process.env.OPENCODE_CLAUDE_AUTH_CLI_TIMEOUT_MS = "12345"
    try {
      const now = Date.now()
      const { credentialsModule, childProcessModule } = await loadCredentials(
        now - 1_000,
      )
      credentialsModule.initAccounts([account(now - 1_000)])

      await credentialsModule.getCachedCredentials()

      assert.equal(
        childProcessModule.__getExecSyncCalls()[0].options?.timeout,
        12345,
      )
    } finally {
      if (saved === undefined) {
        delete process.env.OPENCODE_CLAUDE_AUTH_CLI_TIMEOUT_MS
      } else {
        process.env.OPENCODE_CLAUDE_AUTH_CLI_TIMEOUT_MS = saved
      }
    }
  })

  it("declines the run when the caller asks it to (plugin init)", async () => {
    // Init is awaited before OpenCode has a UI, so a spawn there stalls the
    // launch rather than one request.
    const now = Date.now()
    const { credentialsModule, childProcessModule, loggerModule } =
      await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])

    const creds = await credentialsModule.getCachedCredentials({
      allowCliRefresh: false,
    })

    assert.equal(creds, null)
    assert.equal(childProcessModule.__getExecSyncCount(), 0)
    assert.ok(events(loggerModule).includes("refresh_cli_skipped"))
  })
})

describe("concurrency", () => {
  it("shares one run between concurrent callers in this process", async () => {
    const now = Date.now()
    const { credentialsModule, childProcessModule, keychainModule } =
      await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])
    rotateOnRun(childProcessModule, keychainModule, {
      accessToken: "rotated",
      refreshToken: "refresh2",
      expiresAt: now + 10 * HOUR,
    })

    const results = await Promise.all([
      credentialsModule.getCachedCredentials(),
      credentialsModule.getCachedCredentials(),
      credentialsModule.getCachedCredentials(),
    ])

    assert.ok(results.every((r) => r?.accessToken === "rotated"))
    assert.equal(childProcessModule.__getExecSyncCount(), 1)
  })

  it("does not run `claude` while another process holds the refresh lock", async () => {
    // N runs starting at once produce N refresh-token rotations, and every one
    // but the last is invalidated. On a network where interactive re-auth is
    // impossible that is the one failure with no recovery.
    const now = Date.now()
    const { credentialsModule, childProcessModule, lockModule, loggerModule } =
      await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])
    lockModule.__setGrant(false)

    const creds = await credentialsModule.getCachedCredentials()

    assert.equal(creds, null)
    assert.equal(childProcessModule.__getExecSyncCount(), 0)
    assert.ok(events(loggerModule).includes("refresh_lock_busy"))
  })

  it("sizes the lock TTL to cover the whole blocking hold", async () => {
    // The lock is held across a blocking execSync and cannot be heartbeaten,
    // so a TTL shorter than the hold lets a sibling declare it stale and start
    // a second, concurrent rotation.
    const now = Date.now()
    const { credentialsModule, lockModule } = await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])

    await credentialsModule.getCachedCredentials()

    const ttl = lockModule.__getAcquires()[0]?.ttlMs ?? 0
    // Two attempts at the per-attempt budget, plus margin.
    assert.ok(ttl >= 60_000 * 2, `lock TTL ${ttl} must cover two 60s attempts`)
  })
})

describe("suffixed (multi-account) sources", () => {
  it("does not run `claude` for a suffixed account with no config directory", async () => {
    // Without CLAUDE_CONFIG_DIR the CLI would refresh the primary account
    // instead, quietly rotating the wrong credentials.
    const now = Date.now()
    const { credentialsModule, childProcessModule, loggerModule } =
      await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([
      account(now - 1_000, { source: "Claude Code-credentials-work" }),
    ])

    await credentialsModule.getCachedCredentials()

    assert.equal(childProcessModule.__getExecSyncCount(), 0)
    assert.ok(
      loggerModule
        .__getLogs()
        .some(
          (l) =>
            l.event === "refresh_cli_skipped" &&
            String(l.data?.reason ?? "").includes("configDir"),
        ),
    )
  })

  it("passes CLAUDE_CONFIG_DIR through to the child", async () => {
    const now = Date.now()
    const { credentialsModule, childProcessModule } = await loadCredentials(
      now - 1_000,
    )
    credentialsModule.initAccounts([
      account(now - 1_000, {
        source: "Claude Code-credentials-work",
        configDir: "/tmp/claude-work",
      }),
    ])

    await credentialsModule.getCachedCredentials()

    const env = childProcessModule.__getExecSyncCalls()[0].options?.env ?? {}
    assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/claude-work")
  })

  it("falls back to the primary store when the account's own source is empty", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } = await loadCredentials(
      now - 1_000,
    )
    credentialsModule.initAccounts([
      account(now - 1_000, {
        source: "Claude Code-credentials-work",
        configDir: "/tmp/claude-work",
      }),
    ])
    keychainModule.__setCredentialsForSource("Claude Code-credentials-work", {
      accessToken: "stale",
      refreshToken: "refresh",
      expiresAt: now - 1_000,
    })
    keychainModule.__setCredentialsForSource("Claude Code-credentials", {
      accessToken: "primary-rotated",
      refreshToken: "refresh2",
      expiresAt: now + 10 * HOUR,
    })

    const creds = await credentialsModule.getCachedCredentials()

    assert.equal(creds?.accessToken, "primary-rotated")
  })
})

describe("caching", () => {
  it("serves the cache within its TTL without re-reading the source", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } = await loadCredentials(
      now + 10 * HOUR,
    )
    credentialsModule.initAccounts([account(now + 10 * HOUR)])

    await credentialsModule.getCachedCredentials()
    const readsAfterFirst = keychainModule.__getReadCount()
    await credentialsModule.getCachedCredentials()

    assert.equal(keychainModule.__getReadCount(), readsAfterFirst)
  })

  it("re-reads the source after the cache is invalidated", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } = await loadCredentials(
      now + 10 * HOUR,
    )
    credentialsModule.initAccounts([account(now + 10 * HOUR)])

    await credentialsModule.getCachedCredentials()
    const readsAfterFirst = keychainModule.__getReadCount()
    credentialsModule.invalidateCredentialCache()
    await credentialsModule.getCachedCredentials()

    assert.ok(keychainModule.__getReadCount() > readsAfterFirst)
  })

  it("drops the cache when resolution fails", async () => {
    const now = Date.now()
    const { credentialsModule } = await loadCredentials(now - 1_000)
    credentialsModule.initAccounts([account(now - 1_000)])

    assert.equal(await credentialsModule.getCachedCredentials(), null)
    assert.equal(await credentialsModule.getCachedCredentials(), null)
  })
})

describe("background sync never refreshes", () => {
  it("returns valid credentials for mirroring", async () => {
    const now = Date.now()
    const { credentialsModule } = await loadCredentials(now + 10 * HOUR)
    credentialsModule.initAccounts([account(now + 10 * HOUR)])

    assert.ok(credentialsModule.getCredentialsForSync())
  })

  it("returns null rather than running `claude` on a timer", async () => {
    // A refreshing timer is what drove the token endpoint to 429 in 2.1.4, and
    // under this policy it would bill a request and freeze the process every
    // five minutes.
    const now = Date.now()
    const { credentialsModule, childProcessModule } = await loadCredentials(
      now - 1_000,
    )
    credentialsModule.initAccounts([account(now - 1_000)])

    assert.equal(credentialsModule.getCredentialsForSync(), null)
    assert.equal(childProcessModule.__getExecSyncCount(), 0)
  })
})

describe("401 recovery", () => {
  it("reloadCredentialsFromSource adopts a usable rotated blob", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } = await loadCredentials(
      now + 10 * HOUR,
    )
    credentialsModule.initAccounts([account(now + 10 * HOUR)])
    keychainModule.__setCredentials({
      accessToken: "rotated-elsewhere",
      refreshToken: "refresh2",
      expiresAt: now + 10 * HOUR,
    })

    assert.equal(
      credentialsModule.reloadCredentialsFromSource()?.accessToken,
      "rotated-elsewhere",
    )
  })

  it("reloadCredentialsFromSource rejects an expiring blob", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } = await loadCredentials(
      now + 10 * HOUR,
    )
    credentialsModule.initAccounts([account(now + 10 * HOUR)])
    keychainModule.__setCredentials({
      accessToken: "nearly-dead",
      refreshToken: "refresh2",
      expiresAt: now + 1_000,
    })

    assert.equal(credentialsModule.reloadCredentialsFromSource(), null)
  })

  it("forceRefreshActiveAccount runs `claude` even though the token looks valid", async () => {
    // The token looks fine locally; the API just rejected it.
    const now = Date.now()
    const { credentialsModule, childProcessModule, keychainModule } =
      await loadCredentials(now + 10 * HOUR)
    credentialsModule.initAccounts([account(now + 10 * HOUR)])
    rotateOnRun(childProcessModule, keychainModule, {
      accessToken: "rotated",
      refreshToken: "refresh2",
      expiresAt: now + 10 * HOUR,
    })

    const creds = await credentialsModule.forceRefreshActiveAccount()

    assert.equal(creds?.accessToken, "rotated")
    assert.equal(childProcessModule.__getExecSyncCount(), 1)
  })

  it("forceRefreshActiveAccount rejects an unchanged token", async () => {
    const now = Date.now()
    const { credentialsModule } = await loadCredentials(now + 10 * HOUR)
    credentialsModule.initAccounts([account(now + 10 * HOUR)])

    assert.equal(await credentialsModule.forceRefreshActiveAccount(), null)
  })

  it("forceRefreshActiveAccount respects the cooldown so a 401 loop is not a claude loop", async () => {
    const now = Date.now()
    const { credentialsModule, childProcessModule, loggerModule } =
      await loadCredentials(now + 10 * HOUR)
    credentialsModule.initAccounts([account(now + 10 * HOUR)])

    await credentialsModule.forceRefreshActiveAccount()
    await credentialsModule.forceRefreshActiveAccount()
    await credentialsModule.forceRefreshActiveAccount()

    // The store keeps handing back the token the API rejected, so the run is
    // not a success and the cooldown it armed stands.
    assert.equal(childProcessModule.__getExecSyncCount(), 1)
    assert.ok(events(loggerModule).includes("force_refresh_cooldown_skip"))
  })
})

describe("syncAuthJson", () => {
  it("writes auth.json with owner-only permissions", async () => {
    const now = Date.now()
    const home = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    const savedHome = process.env.HOME
    process.env.HOME = home
    try {
      const { credentialsModule } = await loadCredentials(now + 10 * HOUR)
      credentialsModule.syncAuthJson({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: now + 10 * HOUR,
      })

      const authPath = join(home, ".local", "share", "opencode", "auth.json")
      const parsed = JSON.parse(readFileSync(authPath, "utf8")) as {
        anthropic: { type: string; access: string; expires: number }
      }
      assert.equal(parsed.anthropic.type, "oauth")
      assert.equal(parsed.anthropic.access, "a")
      assert.equal(statSync(authPath).mode & 0o777, 0o600)
    } finally {
      process.env.HOME = savedHome
      if (savedHome === undefined) delete process.env.HOME
    }
  })

  it("preserves unrelated providers already in auth.json", async () => {
    const now = Date.now()
    const home = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    const savedHome = process.env.HOME
    process.env.HOME = home
    try {
      const dir = join(home, ".local", "share", "opencode")
      const { mkdirSync: mk } = await import("node:fs")
      mk(dir, { recursive: true })
      await writeFile(
        join(dir, "auth.json"),
        JSON.stringify({ "opencode-go": { type: "api", key: "k" } }),
        "utf8",
      )
      chmodSync(join(dir, "auth.json"), 0o600)

      const { credentialsModule } = await loadCredentials(now + 10 * HOUR)
      credentialsModule.syncAuthJson({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: now + 10 * HOUR,
      })

      const parsed = JSON.parse(
        readFileSync(join(dir, "auth.json"), "utf8"),
      ) as Record<string, unknown>
      assert.ok(parsed["opencode-go"])
      assert.ok(parsed.anthropic)
    } finally {
      process.env.HOME = savedHome
      if (savedHome === undefined) delete process.env.HOME
    }
  })
})

describe("module surface", () => {
  it("still names the host the claude CLI needs to reach", () => {
    // Nothing in credentials.ts dials it any more, but the request path reports
    // it, because "which host does the refresh actually need" is the first
    // question on a filtered network.
    assert.equal(OAUTH_TOKEN_URL, "https://claude.ai/v1/oauth/token")
  })

  it("the real refresh lock is still usable", () => {
    const lock = acquireRefreshLock("surface-check", { ttlMs: 1_000 })
    assert.ok(lock)
    lock.release()
  })
})
