/**
 * Best-effort cross-process single-flight lock for OAuth token refreshes.
 *
 * The plugin runs inside every OpenCode process, so several instances (plus the
 * `claude` CLI) can all decide to refresh the same expired token at once and
 * bury the endpoint in duplicate requests — the token endpoint answers the pile
 * with HTTP 429. An advisory lock file lets exactly one refresher proceed; the
 * others wait briefly and adopt the winner's freshly written token from the
 * shared credential store.
 *
 * "Best-effort" is deliberate: any filesystem error degrades to running the
 * refresh without a lock rather than blocking it. A crashed holder cannot
 * wedge the system either — the lock carries a TTL and a stale one is taken
 * over.
 *
 * Because a stale lock can be taken over while its original holder is still
 * running, releasing is ownership-checked: a holder that outlived its TTL
 * finds the successor's payload in the file and leaves it alone rather than
 * unlinking it. Without that check the overrunning holder deletes the lock a
 * live successor is holding, and a third process walks straight in on top of
 * both — the exact duplicate-refresh pile-up this module exists to prevent.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { log } from "./logger.ts"

/**
 * How long before a held lock is considered stale (env-overridable).
 *
 * This default is sized for a hold that is nothing but an OAuth round trip. A
 * caller whose hold can run longer than that must pass its own budget via
 * {@link AcquireOptions.ttlMs} instead of leaning on this number.
 */
export const DEFAULT_LOCK_TTL_MS = (() => {
  const raw = process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000
})()

export interface RefreshLock {
  /**
   * Give the lock up. Idempotent, and never throws: the caller runs this from
   * a `finally`, where a throw would replace the refresh's own result.
   *
   * The lock file is removed only while this handle still owns it. See
   * {@link AcquireOptions.ttlMs} for what happens when it does not.
   */
  release(): void
}

export interface AcquireOptions {
  /** Directory to hold lock files in. Defaults to the OpenCode data dir. */
  dir?: string
  /**
   * Staleness threshold in ms. Defaults to {@link DEFAULT_LOCK_TTL_MS}.
   *
   * A caller that holds the lock across a blocking subprocess MUST pass a
   * ttlMs that covers the WHOLE hold — every network budget plus the spawn
   * deadline plus the child's own shutdown flush, which outlives the SIGTERM
   * that deadline sends. The TTL has to be right up front because a held lock
   * cannot be kept alive as it runs: its freshness is the lock file's mtime,
   * and the hold that needs a heartbeat is exactly the one that cannot have
   * one — execSync freezes the single-threaded runtime outright, so no timer,
   * no I/O callback and no touch of the file runs until the child exits.
   * (Rejected: a background thread or child process to beat the heartbeat.
   * That is a second moving part guarding a lock that is advisory anyway, and
   * it would still have to be torn down from the frozen thread.)
   *
   * Sizing it too short is wasteful, not corrupting. {@link RefreshLock.release}
   * refuses to unlink a lock this handle no longer owns, so an overrun costs
   * one duplicate refresh — the successor's — and a `refresh_lock_overrun`
   * event naming the hold that ran long, instead of one process deleting
   * another's live lock and letting a third in behind it.
   */
  ttlMs?: number
  now?: () => number
}

function defaultLockDir(): string {
  // Read at call time so tests (and unusual deployments) can redirect the lock
  // directory without reloading the module.
  return (
    process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR ??
    join(homedir(), ".local", "share", "opencode")
  )
}

function lockPathFor(source: string, dir: string): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16)
  return join(dir, `claude-auth-refresh-${digest}.lock`)
}

const NOOP_LOCK: RefreshLock = { release() {} }

/** What the lock file holds, relative to the handle asking about it. */
type LockOwnership = "ours" | "foreign" | "missing" | "unreadable"

/**
 * Report whether the lock file at `path` still carries the payload the handle
 * wrote at `ownerTs`.
 *
 * Only an exact match counts as ours; a file we cannot read or cannot parse is
 * reported as not-ours. That asymmetry is the whole point. Unlinking a lock we
 * do not own releases a live successor's mutual exclusion and puts two
 * refreshers on the token endpoint at once, which is what buries it in 429s;
 * leaving one we do own costs at most a single TTL of extra waiting before the
 * stale-takeover path in acquireRefreshLock clears it for us. Between an
 * unbounded correctness failure and a bounded stall, take the stall.
 *
 * The timestamp, not the pid, is what discriminates here: a lock and its
 * successor are usually two processes, but they can be the same one taking
 * over its own abandoned lock, and pids are recycled besides. Two acquires by
 * one process can only collide on `ts` if they land in the same millisecond,
 * and they cannot: the second one is a takeover, which requires a positive
 * ttlMs to have elapsed since the first wrote its payload.
 *
 * Accepted residual: when the payload never wrote (a failed writeSync in
 * acquireRefreshLock), ownership is unprovable and the file can only ever be
 * cleared by the TTL takeover. Siblings wait out one TTL; nobody loses a
 * refresh token over it.
 */
function readOwnership(path: string, ownerTs: number): LockOwnership {
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable"
  }
  let payload: { pid?: unknown; ts?: unknown }
  try {
    payload = JSON.parse(raw) as { pid?: unknown; ts?: unknown }
  } catch {
    return "unreadable"
  }
  return payload.pid === process.pid && payload.ts === ownerTs
    ? "ours"
    : "foreign"
}

/**
 * Try to acquire the refresh lock for `source`.
 *
 * Returns a {@link RefreshLock} when this process may refresh (either it won the
 * lock, or a filesystem error made the lock unavailable and we degrade to
 * best-effort). Returns null when a live holder currently owns it — the caller
 * should wait and adopt the holder's result instead of refreshing.
 */
export function acquireRefreshLock(
  source: string,
  opts: AcquireOptions = {},
): RefreshLock | null {
  const dir = opts.dir ?? defaultLockDir()
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS
  const now = opts.now ?? Date.now
  const path = lockPathFor(source, dir)

  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Non-fatal: openSync below will surface a real problem.
  }

  // Two attempts: the second only runs after clearing a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      fd = openSync(path, "wx")
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "EEXIST") {
        // Unexpected FS failure — never let the lock block a refresh.
        log("refresh_lock_error", { source, error: String(code ?? err) })
        return NOOP_LOCK
      }
      // Someone holds it. Take over only if it is stale.
      let stale = false
      try {
        stale = now() - statSync(path).mtimeMs > ttlMs
      } catch {
        // Vanished between open and stat — retry the acquire.
        stale = true
      }
      if (stale) {
        log("refresh_lock_stale_takeover", { source })
        try {
          unlinkSync(path)
        } catch {
          // Lost the race to remove it; the next attempt/stat settles it.
        }
        continue
      }
      return null
    }

    // Kept so release() can prove the file it is about to unlink is still the
    // one this handle created, rather than a successor's.
    const ownerTs = now()
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: ownerTs }))
    } catch {
      // The lock is held regardless of whether the payload wrote — but see
      // readOwnership(): with no payload to match, release() can no longer
      // prove the file is ours and will leave it for the TTL takeover.
    }
    log("refresh_lock_acquired", { source })
    let released = false
    return {
      release() {
        // Idempotent, so a second release cannot report a phantom overrun for
        // the file the first one legitimately removed.
        if (released) return
        released = true
        try {
          closeSync(fd)
        } catch {
          // already closed
        }

        const ownership = readOwnership(path, ownerTs)
        if (ownership === "ours") {
          try {
            unlinkSync(path)
          } catch {
            // Raced with a takeover between the read and the unlink; the file
            // we meant to remove is already gone. Accepted residual: that
            // window is real — POSIX has no compare-and-unlink — but it is
            // microseconds wide, against the unbounded window this check
            // closes (a whole blocking spawn's worth of overrun).
          }
          return
        }

        // Not ours any more: our hold outlived the TTL, a sibling declared the
        // lock stale, and this path is now someone else's file. Removing it
        // would hand the endpoint to that successor AND to whoever acquires
        // next. Leave it, and say so — this event is the only place a user
        // sees that a hold ran past its TTL, and the only signal telling them
        // which ttlMs to raise.
        log("refresh_lock_overrun", {
          source,
          reason: ownership,
          heldMs: now() - ownerTs,
          ttlMs,
        })
      },
    }
  }

  return null
}
