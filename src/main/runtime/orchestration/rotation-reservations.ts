import type { RustOrchestrationStoreHandle } from '../../daemon/rust-git-addon'
import { listFromJson, optRowFromJson, rowFromJson } from './db-row-json'
import { generateId } from './row-id'
import type { ReservationClaimOutcome, RotationSagaPhase, RotationSagaRow } from './types'

/**
 * Rotation-saga reservations (design §4, §8.3). The shim's only job here is the
 * nondeterminism: the saga id and the two ISO stamps (`now`, `expiresAt`). The
 * sweep-expired-then-claim transaction is one `BEGIN IMMEDIATE` inside Rust,
 * because a partial unique index is lifted only by a row transactionally marked
 * released — an elapsed expiry does not make a constraint lapse on its own.
 */
export class RotationReservationStore {
  constructor(private store: RustOrchestrationStoreHandle) {}

  /** Claim a target for a rotation. `conflict` names the live holder rather than
   *  throwing — losing a race to a successor is an expected routing outcome. */
  claim(request: {
    provider: string
    /** RouteKey string (design §3a) — never a bare account id. */
    targetRouteKey: string
    /** StoreKey string; omit when the transition locks no credential surface. */
    targetStoreKey?: string | null
    sourceRouteKey?: string | null
    /** How long the claim stands without renewal. */
    ttlMs: number
  }): ReservationClaimOutcome {
    const now = new Date()
    return rowFromJson<ReservationClaimOutcome>(
      this.store.claimRotationReservation(
        generateId('saga'),
        request.provider,
        request.targetRouteKey,
        request.targetStoreKey ?? null,
        request.sourceRouteKey ?? null,
        new Date(now.getTime() + request.ttlMs).toISOString(),
        now.toISOString()
      )
    )
  }

  /** Fenced release. `false` means the fence moved on — a stale saga must not be
   *  able to free the claim its successor now holds. */
  release(sagaId: string, fence: number): boolean {
    return this.store.releaseRotationReservation(sagaId, fence, new Date().toISOString())
  }

  /** Fenced extension. `false` means the reservation was lost; the saga stops. */
  renew(sagaId: string, fence: number, ttlMs: number): boolean {
    return this.store.renewRotationReservation(
      sagaId,
      fence,
      new Date(Date.now() + ttlMs).toISOString(),
      new Date().toISOString()
    )
  }

  /** Fenced phase advance; `undefined` when the reservation was lost or released. */
  advancePhase(
    sagaId: string,
    fence: number,
    phase: RotationSagaPhase,
    lastError?: string
  ): RotationSagaRow | undefined {
    return optRowFromJson<RotationSagaRow>(
      this.store.advanceRotationSagaPhase(
        sagaId,
        fence,
        phase,
        lastError ?? null,
        new Date().toISOString()
      )
    )
  }

  get(sagaId: string): RotationSagaRow | undefined {
    return optRowFromJson<RotationSagaRow>(this.store.getRotationSaga(sagaId))
  }

  /** Unreleased reservations — startup reconciliation's input (§8.3 rolls each
   *  forward, restores source authority, or marks `needs-human`). */
  listLive(provider?: string): RotationSagaRow[] {
    return listFromJson<RotationSagaRow>(this.store.listLiveRotationSagas(provider))
  }
}
