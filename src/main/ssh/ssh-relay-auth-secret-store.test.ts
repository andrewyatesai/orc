import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent-user-data' } }))

import { relayAuthSecretForTarget, resetRelayAuthSecretCache } from './ssh-relay-auth-secret-store'
import { isRelayAuthSecret } from '../../shared/ssh-relay-auth-token'

describe('relay auth secret store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-relay-secret-'))
    resetRelayAuthSecretCache()
  })

  afterEach(() => {
    resetRelayAuthSecretCache()
    rmSync(dir, { recursive: true, force: true })
  })

  it('mints a persisted secret and returns the same one on a later app run', () => {
    const first = relayAuthSecretForTarget('target-a', { dir })
    expect(isRelayAuthSecret(first)).toBe(true)

    // A later run re-reads from disk rather than minting; that is what lets the
    // host re-attach to a relay it left running.
    resetRelayAuthSecretCache()
    expect(relayAuthSecretForTarget('target-a', { dir })).toBe(first)
  })

  it('keeps targets separate', () => {
    const a = relayAuthSecretForTarget('target-a', { dir })
    const b = relayAuthSecretForTarget('target-b', { dir })
    expect(a).not.toBe(b)
  })

  it.skipIf(process.platform === 'win32')('writes the secret owner-only', () => {
    relayAuthSecretForTarget('target-a', { dir })
    const [file] = require('node:fs').readdirSync(dir) as string[]
    expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600)
  })

  // The attack: a same-uid process on the *host* pre-points the secret path at a
  // file it can read. O_EXCL|O_NOFOLLOW must refuse to write through it.
  it.skipIf(process.platform === 'win32')(
    'never writes the secret through a planted symlink',
    () => {
      const decoy = join(dir, 'decoy')
      writeFileSync(decoy, 'PRECIOUS')
      // Mint once to learn the path this target hashes to, then re-plant it.
      const probeDir = mkdtempSync(join(tmpdir(), 'orca-relay-secret-probe-'))
      relayAuthSecretForTarget('target-a', { dir: probeDir })
      const [fileName] = require('node:fs').readdirSync(probeDir) as string[]
      rmSync(probeDir, { recursive: true, force: true })
      resetRelayAuthSecretCache()

      mkdirSync(dir, { recursive: true })
      symlinkSync(decoy, join(dir, fileName))

      const secret = relayAuthSecretForTarget('target-a', { dir })

      expect(isRelayAuthSecret(secret)).toBe(true)
      expect(readFileSync(decoy, 'utf-8')).toBe('PRECIOUS')
      // The link is replaced by a file we created, never written through.
      expect(lstatSync(join(dir, fileName)).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(dir, fileName), 'utf-8')).toBe(secret)
    }
  )

  // Why: never fail-open. An unwritable store costs cross-restart revival, not
  // the credential itself.
  it('still returns a session secret when the store cannot be written', () => {
    const unwritable = join(dir, 'not-a-dir')
    writeFileSync(unwritable, 'blocked')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const secret = relayAuthSecretForTarget('target-a', { dir: unwritable })

    expect(isRelayAuthSecret(secret)).toBe(true)
    expect(relayAuthSecretForTarget('target-a', { dir: unwritable })).toBe(secret)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('re-mints when the stored value is not a well-formed secret', () => {
    const first = relayAuthSecretForTarget('target-a', { dir })
    const [fileName] = require('node:fs').readdirSync(dir) as string[]
    writeFileSync(join(dir, fileName), 'truncated-garbage')
    resetRelayAuthSecretCache()

    const second = relayAuthSecretForTarget('target-a', { dir })
    expect(isRelayAuthSecret(second)).toBe(true)
    expect(second).not.toBe(first)
  })
})
