import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import { acquireRefreshLock } from "./refresh-lock.ts"
import { closeLogger, initLogger } from "./logger.ts"

const SRC = "Claude Code-credentials"

/** The lock file names currently present, whatever their hashed source. */
function lockFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".lock"))
}

/** Path of the single lock file expected to exist right now. */
function soleLockPath(dir: string): string {
  const files = lockFiles(dir)
  assert.equal(files.length, 1, "expected exactly one lock file")
  return join(dir, files[0]!)
}

describe("refresh-lock", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opencode-claude-auth-lock-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("grants the lock to the first caller and denies a second holder", () => {
    const first = acquireRefreshLock(SRC, { dir })
    assert.ok(first, "first caller acquires the lock")
    const second = acquireRefreshLock(SRC, { dir })
    assert.equal(second, null, "a live holder blocks a second acquirer")
    first!.release()
  })

  it("releases the lock so a later caller can acquire it", () => {
    const first = acquireRefreshLock(SRC, { dir })
    assert.ok(first)
    first!.release()
    const second = acquireRefreshLock(SRC, { dir })
    assert.ok(second, "the lock is available again after release")
    second!.release()
  })

  it("takes over a stale lock past its TTL", () => {
    const held = acquireRefreshLock(SRC, { dir, ttlMs: 20_000 })
    assert.ok(held)
    // The holder "crashes" without releasing; the lock file lingers. A later
    // acquirer looking from far enough in the future treats it as stale.
    const future = Date.now() + 60_000
    const takeover = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 20_000,
      now: () => future,
    })
    assert.ok(takeover, "a stale lock is taken over")
    takeover!.release()
  })

  it("does not take over a lock that is still within its TTL", () => {
    const held = acquireRefreshLock(SRC, { dir, ttlMs: 60_000 })
    assert.ok(held)
    const soon = Date.now() + 1_000
    const denied = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 60_000,
      now: () => soon,
    })
    assert.equal(denied, null, "a fresh lock is respected")
    held!.release()
  })

  it("keeps locks for different sources independent", () => {
    const a = acquireRefreshLock("source-a", { dir })
    const b = acquireRefreshLock("source-b", { dir })
    assert.ok(a, "source-a acquires")
    assert.ok(b, "source-b acquires independently")
    a!.release()
    b!.release()
  })

  it("removes the lock file on release", () => {
    const lock = acquireRefreshLock(SRC, { dir })
    assert.ok(lock)
    assert.equal(readdirSync(dir).length, 1, "a lock file exists while held")
    lock!.release()
    assert.equal(
      readdirSync(dir).filter((f) => f.endsWith(".lock")).length,
      0,
      "the lock file is removed on release",
    )
  })

  it("removes its own lock file on release and lets the next caller in", () => {
    const first = acquireRefreshLock(SRC, { dir })
    assert.ok(first)
    assert.equal(lockFiles(dir).length, 1, "a lock file exists while held")

    first!.release()
    assert.equal(
      lockFiles(dir).length,
      0,
      "an owned lock file is still removed on release",
    )

    const second = acquireRefreshLock(SRC, { dir })
    assert.ok(second, "the lock is acquirable again after a normal release")
    second!.release()
  })

  it("does not delete a successor's lock file when its hold outran the TTL", () => {
    // The 2.2.3 CLI fallback runs inside this lock, and execSync freezes the
    // event loop, so a hold can outlive the TTL with no way to heartbeat. The
    // holder must not take the successor's lock down with it when it finally
    // returns.
    const held = acquireRefreshLock(SRC, { dir, ttlMs: 200 })
    assert.ok(held)

    const takeover = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 200,
      now: () => Date.now() + 210,
    })
    assert.ok(takeover, "a sibling takes the lock over once it looks stale")
    const successorPayload = readFileSync(soleLockPath(dir), "utf-8")

    held!.release()

    assert.equal(
      readFileSync(soleLockPath(dir), "utf-8"),
      successorPayload,
      "the successor's lock file survives the overrunning holder's release",
    )
    assert.equal(
      acquireRefreshLock(SRC, { dir, ttlMs: 200 }),
      null,
      "no third refresher gets in on top of the live successor",
    )
    takeover!.release()
  })

  it("leaves a lock file owned by another process alone on release", () => {
    const lock = acquireRefreshLock(SRC, { dir })
    assert.ok(lock)
    const path = soleLockPath(dir)
    // What a real cross-process takeover leaves behind: same path, a payload
    // written by a different pid.
    const foreign = JSON.stringify({ pid: process.pid + 1, ts: Date.now() })
    writeFileSync(path, foreign)

    lock!.release()

    assert.equal(
      readFileSync(path, "utf-8"),
      foreign,
      "another process's lock file is left untouched",
    )
  })

  it("reports an overrun release so the hold that ran long is visible", () => {
    const lines: string[] = []
    initLogger({
      stream: new Writable({
        write(chunk, _enc, cb) {
          lines.push(chunk.toString())
          cb()
        },
      }),
    })
    try {
      const held = acquireRefreshLock(SRC, { dir, ttlMs: 200 })
      assert.ok(held)
      const takeover = acquireRefreshLock(SRC, {
        dir,
        ttlMs: 200,
        now: () => Date.now() + 210,
      })
      assert.ok(takeover)

      held!.release()

      const entry = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((e) => e.event === "refresh_lock_overrun")
      assert.ok(entry, "expected a refresh_lock_overrun log line")
      assert.equal(entry.source, SRC)
      assert.equal(entry.reason, "foreign")
      assert.equal(entry.ttlMs, 200, "the TTL that was overrun is named")
      takeover!.release()
    } finally {
      closeLogger()
    }
  })

  it("does not throw when its lock file was deleted out from under it", () => {
    const lock = acquireRefreshLock(SRC, { dir })
    assert.ok(lock)
    rmSync(soleLockPath(dir))

    assert.doesNotThrow(() => lock!.release())
    assert.equal(lockFiles(dir).length, 0)
  })

  it("does not throw or unlink when the lock payload is unparseable", () => {
    const lock = acquireRefreshLock(SRC, { dir })
    assert.ok(lock)
    const path = soleLockPath(dir)
    writeFileSync(path, "{ not json")

    assert.doesNotThrow(() => lock!.release())
    assert.equal(
      readFileSync(path, "utf-8"),
      "{ not json",
      "an unprovable lock is left for the TTL takeover, not deleted",
    )
  })

  it("tolerates being released twice", () => {
    const lock = acquireRefreshLock(SRC, { dir })
    assert.ok(lock)
    lock!.release()
    assert.doesNotThrow(() => lock!.release())
    const next = acquireRefreshLock(SRC, { dir })
    assert.ok(next, "a double release does not wedge the lock")
    next!.release()
  })

  it("degrades to best-effort (grants) when the lock dir is unusable", () => {
    // Point at a path whose parent is a file, so mkdir/open cannot create the
    // lock. The lock must never block a refresh — it grants a no-op handle.
    const filePath = join(dir, "not-a-dir")
    // create a regular file, then use a path underneath it as the lock dir
    writeFileSync(filePath, "x")
    const lock = acquireRefreshLock(SRC, { dir: join(filePath, "sub") })
    assert.ok(lock, "an unusable lock dir degrades to a granted no-op lock")
    lock!.release()
    assert.ok(!existsSync(join(filePath, "sub")))
  })
})
