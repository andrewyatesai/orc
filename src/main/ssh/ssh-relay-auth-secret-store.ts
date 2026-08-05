// Host-side home of the relay's per-target secret.
//
// It lives here, and only here, on purpose: see src/shared/ssh-relay-auth-token.ts
// for why a copy on the remote would gate nothing. The consequence is that losing
// this file loses the ability to re-attach to a relay that is still running — the
// deploy path then reaps that relay and launches a fresh one, the same recovery it
// already performs for a failed socket reconnect. That is acceptable because the
// pane leases this secret would revive live in the same host state; state loss that
// orphans the secret has already orphaned the panes.

import { app } from 'electron'
import {
  constants,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { hashRelayInstanceId } from './ssh-relay-instance-id'
import { isRelayAuthSecret, mintRelayAuthSecret } from '../../shared/ssh-relay-auth-token'

const SECRET_DIR_NAME = 'ssh-relay-auth'
const DEFAULT_INSTANCE_KEY = 'default'

// Why: one mint per target per app run even if the file is unwritable, so every
// launch and every --connect inside a session agree on the same credential.
const cache = new Map<string, string>()

function secretDir(overrideDir?: string): string {
  return overrideDir ?? join(app.getPath('userData'), SECRET_DIR_NAME)
}

function secretPath(dir: string, relayInstanceId: string | undefined): string {
  return join(dir, `${hashRelayInstanceId(relayInstanceId ?? DEFAULT_INSTANCE_KEY)}.token`)
}

// Why: O_NOFOLLOW so a planted symlink cannot redirect the read (or, below, the
// write) at another file — mirrors orca-daemon's token.rs. Windows has no
// unprivileged symlink to plant and no O_NOFOLLOW, so the flag drops there.
// Read at call time, not module load: importers routinely run under a partial fs mock.
function nofollow(): number {
  return process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
}

function readSecretFile(path: string): string | null {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | nofollow())
    const raw = readFileSync(fd, 'utf-8').trim()
    return isRelayAuthSecret(raw) ? raw : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

// Why: unlink-then-create-exclusive, with the mode forced through the open fd
// (`fchmod`) rather than a second path lookup — a `mode` on open only applies
// when the open creates the file, so writing through a pre-placed file or link
// would otherwise hand the secret to whatever sits at that path.
function writeSecretFile(path: string, secret: string): void {
  let fd: number | undefined
  try {
    unlinkSync(path)
  } catch {
    /* nothing to replace */
  }
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow(),
      0o600
    )
    if (process.platform !== 'win32') {
      fchmodSync(fd, 0o600)
    }
    writeSync(fd, secret)
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

/**
 * The control secret for one SSH target, minted on first use and persisted so a
 * relay that outlives the app can still be re-authenticated after a restart.
 *
 * Never throws: an unwritable store degrades to a session-only secret (the channel
 * is still authenticated; only cross-restart revival is lost), never to no secret.
 */
export function relayAuthSecretForTarget(
  relayInstanceId: string | undefined,
  options?: { dir?: string }
): string {
  const key = relayInstanceId ?? DEFAULT_INSTANCE_KEY
  const cached = cache.get(key)
  if (cached) {
    return cached
  }
  let dir: string
  let path: string
  try {
    dir = secretDir(options?.dir)
    path = secretPath(dir, relayInstanceId)
  } catch (err) {
    const secret = mintRelayAuthSecret()
    cache.set(key, secret)
    console.warn(
      `[ssh-relay] Relay credential store unavailable (${err instanceof Error ? err.message : String(err)}); using a session-only secret.`
    )
    return secret
  }

  const stored = readSecretFile(path)
  if (stored) {
    cache.set(key, stored)
    return stored
  }

  const secret = mintRelayAuthSecret()
  cache.set(key, secret)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeSecretFile(path, secret)
  } catch (err) {
    console.warn(
      `[ssh-relay] Could not persist the relay credential (${err instanceof Error ? err.message : String(err)}); ` +
        'a relay left running past this app run will be relaunched instead of re-attached.'
    )
  }
  return secret
}

/** Test seam: drop memoized secrets so a fresh store directory is honored. */
export function resetRelayAuthSecretCache(): void {
  cache.clear()
}
