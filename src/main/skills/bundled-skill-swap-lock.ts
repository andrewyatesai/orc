import { randomBytes } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const SWAP_LOCK_WAIT_MS = 10_000
const SWAP_LOCK_RETRY_MS = 25
// Why: a lock a killed process left behind must not wedge the installer forever.
const SWAP_LOCK_STALE_MS = 5 * 60 * 1000
// Why: `wx` creates the file before the record lands in it; an empty lock is young, not broken.
const SWAP_LOCK_WRITE_GRACE_MS = 2_000

/**
 * The lock every Orca process must hold to displace one skill package.
 *
 * Advisory and single-host by construction: liveness is a pid check, so a home shared
 * over NFS or SMB can hand the same package to two machines at once. It orders writers
 * within a host; the swap journal is what survives losing that bet.
 */
export function skillPackageSwapLockPath(packagePath: string): string {
  return join(dirname(packagePath), `.${basename(packagePath)}.orca-swap.lock`)
}

type SwapLockRecord = { token: string; pid: number; host: string; at: number }

async function readSwapLock(lockPath: string): Promise<SwapLockRecord | null> {
  const raw = await readFile(lockPath, 'utf8').catch(() => null)
  if (raw === null) {
    return null
  }
  try {
    const record = JSON.parse(raw) as Partial<SwapLockRecord>
    return typeof record.token === 'string' &&
      typeof record.pid === 'number' &&
      typeof record.host === 'string' &&
      typeof record.at === 'number'
      ? (record as SwapLockRecord)
      : null
  } catch {
    return null
  }
}

function ownerProcessIsGone(record: SwapLockRecord): boolean {
  if (Date.now() - record.at > SWAP_LOCK_STALE_MS) {
    return true
  }
  // Pids only mean something on the host that recorded them; foreign locks age out.
  if (record.host !== hostname()) {
    return false
  }
  try {
    process.kill(record.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'EPERM'
  }
}

async function swapLockIsReclaimable(lockPath: string): Promise<boolean> {
  const record = await readSwapLock(lockPath)
  if (record) {
    return ownerProcessIsGone(record)
  }
  const stats = await lstat(lockPath).catch(() => null)
  return stats
    ? Date.now() - Math.max(stats.mtimeMs, stats.ctimeMs) > SWAP_LOCK_WRITE_GRACE_MS
    : false
}

async function tryCreateSwapLock(lockPath: string): Promise<SwapLockRecord | null> {
  const record: SwapLockRecord = {
    token: randomBytes(8).toString('hex'),
    pid: process.pid,
    host: hostname(),
    at: Date.now()
  }
  const handle = await open(lockPath, 'wx').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') {
      return null
    }
    throw error
  })
  if (!handle) {
    return null
  }
  try {
    await handle.writeFile(JSON.stringify(record))
    await handle.sync()
  } finally {
    await handle.close()
  }
  return record
}

/** Null when the wait expired, meaning another live process owns this package. */
export async function acquireSkillPackageSwapLock(
  packagePath: string,
  waitMs: number
): Promise<(() => Promise<void>) | null> {
  const lockPath = skillPackageSwapLockPath(packagePath)
  const deadline = Date.now() + waitMs
  for (;;) {
    const record = await tryCreateSwapLock(lockPath)
    if (record) {
      return async () => {
        // Never delete a lock someone else reclaimed after ours aged out.
        if ((await readSwapLock(lockPath))?.token === record.token) {
          await rm(lockPath, { force: true }).catch(() => undefined)
        }
      }
    }
    if (await swapLockIsReclaimable(lockPath)) {
      // Only the process whose rename wins may clear it, so two reclaimers cannot
      // both conclude they took over.
      const aside = `${lockPath}.stale-${randomBytes(6).toString('hex')}`
      if (
        await rename(lockPath, aside).then(
          () => true,
          () => false
        )
      ) {
        await rm(aside, { force: true }).catch(() => undefined)
        continue
      }
    }
    if (Date.now() >= deadline) {
      return null
    }
    await delay(SWAP_LOCK_RETRY_MS)
  }
}
