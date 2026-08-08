import type { RustOrchestrationStoreHandle } from '../../daemon/rust-git-addon'
import { rowFromJson } from './db-row-json'
import { restoreCodedError } from './orchestration-error'
import type { DispatchContextRow } from './types'

export type CapabilityVerdict = { valid: true } | { valid: false; reason: string }

/**
 * Dispatch capability tokens (schema v10) — the unforgeable `dcap_` secret a
 * worker presents to prove it is the process a dispatch was handed to, bound to
 * a pane key and a process incarnation. The STORE mints the secret (OS CSPRNG)
 * and persists only its SHA-256; this shim hands the plaintext to the dispatch
 * path exactly once and never stores it.
 *
 * Coded store failures (dispatch_inactive, dispatch_not_found,
 * request_mismatch) arrive as a JSON envelope in Error.message; `coded()`
 * restores them to OrchestrationError so callers branch on `.code`.
 */
export class DispatchCapabilityStore {
  constructor(private store: RustOrchestrationStoreHandle) {}

  private coded<T>(call: () => T): T {
    try {
      return call()
    } catch (error) {
      throw restoreCodedError(error)
    }
  }

  /** Returns the freshly minted `dcap_` plaintext — hand it to the dispatch
   *  preamble and let it die with this call frame. Re-minting supersedes the
   *  prior token and clears any revocation (relaunch semantics). */
  mint(params: { dispatchId: string; paneKey: string; processIncarnation: string }): string {
    return this.coded(() =>
      this.store.mintDispatchCapability(
        params.dispatchId,
        params.paneKey,
        params.processIncarnation
      )
    )
  }

  /** Absent fields are verdicts (`valid: false`), never throws. */
  verify(params: {
    dispatchId: string
    capability: string | undefined
    paneKey: string | undefined
    processIncarnation: string | undefined
  }): CapabilityVerdict {
    return rowFromJson<CapabilityVerdict>(
      this.store.verifyDispatchCapability(
        params.dispatchId,
        params.capability ?? null,
        params.paneKey ?? null,
        params.processIncarnation ?? null
      )
    )
  }

  /** Idempotent (first stamp wins); an unknown id is a no-op. */
  revoke(dispatchId: string): void {
    this.store.revokeDispatchCapability(dispatchId)
  }

  /** First commitment wins: same hash is idempotent, a different one throws
   *  `request_mismatch` rather than overwriting. */
  commitLaunchTokenHash(dispatchId: string, launchTokenHash: string): DispatchContextRow {
    return this.coded(() =>
      rowFromJson<DispatchContextRow>(
        this.store.commitDispatchLaunchTokenHash(dispatchId, launchTokenHash)
      )
    )
  }

  /** Pane/incarnation currency without presenting a capability — for read
   *  paths that only need "is this still the same process". */
  isProcessCurrent(params: {
    dispatchId: string
    paneKey: string | null
    processIncarnation: string | null
  }): boolean {
    return this.store.isDispatchProcessCurrent(
      params.dispatchId,
      params.paneKey,
      params.processIncarnation
    )
  }
}
