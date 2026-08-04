import { OrchestrationDispatchContextStore } from './db-dispatch-contexts'
import { paramsJson } from './orchestration-store-bridge'
import { rowFromJson } from './db-row-json'
import type { DispatchContextRow } from './types'

export class OrchestrationDispatchCapabilityStore extends OrchestrationDispatchContextStore {
  commitDispatchLaunchTokenHash(dispatchId: string, launchTokenHash: string): DispatchContextRow {
    return rowFromJson<DispatchContextRow>(
      this.store.commitDispatchLaunchTokenHash(dispatchId, launchTokenHash)
    )
  }

  /**
   * Returns the freshly minted `dcap_` plaintext. The store owns the CSPRNG,
   * hands the token back exactly once and persists only its hash — hand it to
   * the launcher and never store it here.
   */
  mintDispatchCapability(params: {
    dispatchId: string
    paneKey: string
    processIncarnation: string
  }): string {
    return this.store.mintDispatchCapability(paramsJson(params))
  }

  verifyDispatchCapability(params: {
    dispatchId: string
    capability: string | undefined
    paneKey: string | undefined
    processIncarnation: string | undefined
  }): { valid: true } | { valid: false; reason: string } {
    return rowFromJson<{ valid: true } | { valid: false; reason: string }>(
      this.store.verifyDispatchCapability(paramsJson(params))
    )
  }

  revokeDispatchCapability(dispatchId: string): void {
    this.store.revokeDispatchCapability(dispatchId)
  }

  isDispatchProcessCurrent(params: {
    dispatchId: string
    paneKey: string | null
    processIncarnation: string | null
  }): boolean {
    return this.store.isDispatchProcessCurrent(paramsJson(params))
  }
}
