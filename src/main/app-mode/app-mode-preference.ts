/**
 * The in-memory holder for the `app-mode.json` sidecar —
 * `docs/reference/app-modes.md` §3.5.
 *
 * Modelled on `ActiveViewPreference`, with two deliberate deviations the design
 * calls out, plus one simplification it did not anticipate:
 *
 * 1. **A no-op `set` never creates the file.** `ActiveViewPreference`'s guard is
 *    `value !== this.persisted`, and `persisted` is null on a fresh install — so
 *    a no-op `set('terminal')` creates the file. For modes that would write
 *    `app-mode.json` into every Classic user's profile and break the
 *    byte-unchanged north star.
 *
 * 2. **Writes are guarded by `canWrite`.** `flushActiveViewPreferenceOrThrow`
 *    has no such guard and could write into a vacated profile directory after a
 *    transfer.
 *
 * 3. **No debounce, and therefore no flush.** The sidecar is ~40 bytes and the
 *    underlying write is atomic and synchronous, so there is nothing to lose at
 *    quit. The design budgeted a 100 ms debounce plus a quit-path flush purely to
 *    avoid losing a mode chosen just before exit; writing straight through
 *    removes that failure mode instead of mitigating it.
 */

import type { AppModeId } from '../../shared/app-mode/app-mode-id'
import { parseAppModeId } from '../../shared/app-mode/app-mode-id'
import {
  readAppModeSidecar,
  writeAppModeSidecar,
  type AppModePin
} from './app-mode-sidecar-file'

export class AppModePreference {
  private pin: AppModePin | null
  private unrecognizedMode: string | null
  /** True once anything has been written, so we can tell "user chose Classic"
   *  from "user has never chosen", which decides whether a file should exist. */
  private persisted: boolean

  constructor(
    private readonly dataFile: string,
    /** Store's `writesFrozen` equivalent — false after a profile transfer. */
    private readonly canWrite: () => boolean = () => true
  ) {
    const read = readAppModeSidecar(dataFile)
    this.pin = read.pin
    this.unrecognizedMode = read.unrecognizedMode
    this.persisted = read.pin !== null
  }

  /** The raw pin for the precedence ladder. Null when no file exists. */
  getPin(): AppModePin | null {
    return this.pin
  }

  /** Set when the file names a mode `parseAppModeId` rejects. The file is NOT
   *  overwritten in that case — a user who mistyped one character does not lose
   *  their file, and in an agent-orchestration IDE the file was quite possibly
   *  written by an agent, so silently coercing would hide that from the human. */
  getUnrecognizedMode(): string | null {
    return this.unrecognizedMode
  }

  isLocked(): boolean {
    return this.pin?.lock === true
  }

  /** Returns true when the stored value actually changed. */
  set(mode: AppModeId, options: { lock?: boolean } = {}): boolean {
    const lock = options.lock ?? this.isLocked()
    const currentMode = parseAppModeId(this.pin?.appMode)
    if (this.persisted && currentMode === mode && this.isLocked() === lock) {
      return false
    }
    // The guard that keeps Classic users' profiles free of this file entirely.
    if (!this.persisted && mode === 'classic' && !lock) {
      return false
    }
    if (!this.canWrite()) {
      return false
    }
    writeAppModeSidecar(this.dataFile, mode, lock)
    this.pin = { appMode: mode, lock }
    this.unrecognizedMode = null
    this.persisted = true
    return currentMode !== mode
  }

  /** Adopts a pin observed by the file watcher. Never writes — the file is
   *  already the source of this value. */
  adoptExternalPin(pin: AppModePin | null, unrecognizedMode: string | null): void {
    this.pin = pin
    this.unrecognizedMode = unrecognizedMode
    this.persisted = pin !== null
  }
}
