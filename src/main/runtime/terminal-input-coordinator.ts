/**
 * §5.1 per-PTY input coordinator: one write lease per PTY shared by every
 * *automated* writer (manager, coordinator dispatch, message delivery, query
 * replies). Humans are never serialized through it — they preempt (§5.4), and
 * the phase at preemption decides the outcome.
 *
 * The lease is also the attribution primitive (§5.2a): no agent hook payload
 * says which submission it belongs to, so "the first submit signal while this
 * writer exclusively held the pane" is the identity. Exclusivity is a
 * correctness property here, not tidiness.
 *
 * Two things the wiring owes this module:
 *  - `notePtyPin` is the *only* authority on which incarnation is live. No lease
 *    is granted for a ptyId it has not announced, because a writer's own pin
 *    cannot vouch for the pane it is about to type into.
 *  - Every human path calls in — desktop `pty:write` through `claimHumanInput`,
 *    the mobile input floor through `beginHumanInputFloor`. §5.4: the human
 *    always wins the keyboard, and keeps it for a beat afterwards.
 *
 * Pure module: no Electron, no PTY I/O. The caller writes the bytes and drives
 * the state machine; this decides who may write and reports what was lost.
 */
import { randomUUID } from 'node:crypto'
import { connectionPinRewinds, connectionPinsEqual } from './terminal-input-lease-preemption'
import type {
  AutomatedWriter,
  ConnectionPin,
  HumanInputSource,
  LeaseRevocationCause,
  LeaseRevokedReport,
  LeaseWritePhase
} from './terminal-input-lease-preemption'
import {
  createInputLeaseHandle,
  createInputLeaseRecord,
  inputLeaseWriteAuthority,
  resumeInputLease,
  revokeInputLease,
  suspendInputLease,
  type LeaseWriteAuthority,
  type TerminalInputLease
} from './terminal-input-lease'
import {
  createHumanInputFloorClaim,
  openHumanQuietWindow,
  type HumanInputFloorClaim
} from './terminal-input-human-floor'
import {
  createPaneState,
  paneClosedToAutomation,
  reclaimPane,
  type PtyInputState
} from './terminal-input-pane-registry'

export type { TerminalInputLease } from './terminal-input-lease'
export type { HumanInputFloorClaim, SuspendedOperation } from './terminal-input-human-floor'

export type AcquireInputLeaseRequest = {
  ptyId: string
  pin: ConnectionPin
  writer: AutomatedWriter
  /** Cancels the wait, not an already-granted lease. */
  signal?: AbortSignal
}

export type AcquireInputLeaseResult =
  | { ok: true; lease: TerminalInputLease }
  | {
      ok: false
      /** 'pty-disposed': no live incarnation is registered under this ptyId —
       *  it was disposed, or `notePtyPin` never announced one. */
      reason: 'cancelled' | 'generation-change' | 'pty-disposed'
      currentPin?: ConnectionPin
    }

export type PtyInputSnapshot = {
  holder: {
    operationId: string
    writer: AutomatedWriter
    phase: LeaseWritePhase
    writeAuthority: LeaseWriteAuthority
  } | null
  waiting: number
  /** Reserved plus committed human claims. */
  humanFloors: number
  /** True while §5.4's post-human quiet window holds automation off. */
  humanQuietWindow: boolean
  /** Whether the coordinator is still holding any state for this ptyId. */
  tracked: boolean
}

export type TerminalInputCoordinator = {
  acquire(request: AcquireInputLeaseRequest): Promise<AcquireInputLeaseResult>
  /** A human keystroke reached the pane: instantaneous, always wins, never queues. */
  claimHumanInput(ptyId: string, source: HumanInputSource): LeaseRevokedReport | null
  /** Reserves held human ownership (the mobile input floor) ahead of a write that
   *  may not land; the claim's commit()/rollback() decides what the displaced
   *  automated writer actually lost. */
  beginHumanInputFloor(ptyId: string, source: HumanInputSource): HumanInputFloorClaim
  /** The live incarnation, announced by the runtime: a change aborts the active
   *  lease and drops stale waiters, and a pin that rewinds is ignored. */
  notePtyPin(ptyId: string, pin: ConnectionPin): LeaseRevokedReport | null
  disposePty(ptyId: string): LeaseRevokedReport | null
  inspect(ptyId: string): PtyInputSnapshot
}

/** Long enough to cover a human's inter-keystroke gap, short enough that an
 *  automated writer waiting on the pane is not visibly stalled. */
const DEFAULT_HUMAN_QUIET_WINDOW_MS = 750

export type TerminalInputCoordinatorOptions = {
  now?: () => number
  createOperationId?: () => string
  /** §5.4's post-human hold-off; 0 disables it. */
  humanQuietWindowMs?: number
  /** Injectable so tests drive the window without wall-clock waits; returns a canceller. */
  scheduleQuietWindowEnd?: (end: () => void, delayMs: number) => () => void
}

function scheduleQuietWindowWithTimer(end: () => void, delayMs: number): () => void {
  const timer = setTimeout(end, delayMs)
  timer.unref()
  return () => clearTimeout(timer)
}

type Waiter = {
  request: AcquireInputLeaseRequest
  resolve: (result: AcquireInputLeaseResult) => void
  detach: () => void
}

type Pane = PtyInputState<Waiter>

export function createTerminalInputCoordinator(
  options: TerminalInputCoordinatorOptions = {}
): TerminalInputCoordinator {
  const now = options.now ?? Date.now
  const createOperationId = options.createOperationId ?? randomUUID
  const quietWindowMs = options.humanQuietWindowMs ?? DEFAULT_HUMAN_QUIET_WINDOW_MS
  const scheduleQuietWindowEnd = options.scheduleQuietWindowEnd ?? scheduleQuietWindowWithTimer
  const ptys = new Map<string, Pane>()

  function stateFor(ptyId: string): Pane {
    const existing = ptys.get(ptyId)
    if (existing) {
      return existing
    }
    const created = createPaneState<Waiter>(ptyId)
    ptys.set(ptyId, created)
    return created
  }

  function reclaim(state: Pane): void {
    reclaimPane(ptys, state)
  }

  // Write authority dies immediately, but the slot stays occupied until the loser
  // calls release(): in-flight bytes cannot be recalled, so the next automated
  // writer must not be let in before the loser acknowledges it stopped.
  function revokeActive(
    state: Pane,
    cause: LeaseRevocationCause,
    detail: { humanSource?: HumanInputSource; supersededBy?: ConnectionPin } = {}
  ): LeaseRevokedReport | null {
    return state.active ? revokeInputLease(state.active, { cause, at: now(), ...detail }) : null
  }

  function grant(state: Pane, request: AcquireInputLeaseRequest): TerminalInputLease {
    const record = createInputLeaseRecord({
      operationId: createOperationId(),
      ptyId: request.ptyId,
      writer: request.writer,
      pin: request.pin
    })
    state.active = record
    return createInputLeaseHandle(record, () => {
      if (state.active === record) {
        state.active = null
        settle(state)
      }
    })
  }

  function pump(state: Pane): void {
    while (!state.active && !paneClosedToAutomation(state)) {
      const waiter = state.waiters.shift()
      if (!waiter) {
        return
      }
      waiter.detach()
      if (!state.live || !state.pin) {
        waiter.resolve({ ok: false, reason: 'pty-disposed' })
        continue
      }
      if (!connectionPinsEqual(state.pin, waiter.request.pin)) {
        waiter.resolve({ ok: false, reason: 'generation-change', currentPin: state.pin })
        continue
      }
      waiter.resolve({ ok: true, lease: grant(state, waiter.request) })
    }
  }

  function settle(state: Pane): void {
    pump(state)
    reclaim(state)
  }

  function openQuietWindow(state: Pane): void {
    openHumanQuietWindow(state, {
      delayMs: quietWindowMs,
      schedule: scheduleQuietWindowEnd,
      onEnd: () => settle(state)
    })
  }

  function acquire(request: AcquireInputLeaseRequest): Promise<AcquireInputLeaseResult> {
    // Why first: a cancelled acquisition must leave no trace on the pane. It used
    // to register its own (possibly stale) pin and lock out the live writer.
    if (request.signal?.aborted) {
      return Promise.resolve({ ok: false, reason: 'cancelled' })
    }
    const state = ptys.get(request.ptyId)
    if (!state?.live || !state.pin) {
      return Promise.resolve({ ok: false, reason: 'pty-disposed' })
    }
    if (!connectionPinsEqual(state.pin, request.pin)) {
      return Promise.resolve({ ok: false, reason: 'generation-change', currentPin: state.pin })
    }
    if (!state.active && !paneClosedToAutomation(state)) {
      return Promise.resolve({ ok: true, lease: grant(state, request) })
    }
    return new Promise((resolve) => {
      const waiter: Waiter = { request, resolve, detach: () => {} }
      const onAbort = (): void => {
        const index = state.waiters.indexOf(waiter)
        if (index !== -1) {
          state.waiters.splice(index, 1)
        }
        resolve({ ok: false, reason: 'cancelled' })
        reclaim(state)
      }
      const signal = request.signal
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
        waiter.detach = () => signal.removeEventListener('abort', onAbort)
      }
      state.waiters.push(waiter)
    })
  }

  // A waiter pinned to a superseded incarnation would write into the wrong
  // terminal, so it fails now rather than at the head of the queue.
  function dropStaleWaiters(state: Pane, pin: ConnectionPin): void {
    const kept: Waiter[] = []
    const stale: Waiter[] = []
    for (const waiter of state.waiters) {
      ;(connectionPinsEqual(waiter.request.pin, pin) ? kept : stale).push(waiter)
    }
    state.waiters = kept
    for (const waiter of stale) {
      waiter.detach()
      waiter.resolve({ ok: false, reason: 'generation-change', currentPin: pin })
    }
  }

  function beginHumanInputFloor(ptyId: string, source: HumanInputSource): HumanInputFloorClaim {
    // Why a claim may create state for an unknown pane: the human's ownership has
    // to outlive whatever the coordinator learns about that pane afterwards.
    const state = stateFor(ptyId)
    state.floors.pending += 1
    const active = state.active
    if (active) {
      suspendInputLease(active, source)
    }
    const suspended =
      active?.suspension && !active.report
        ? { operationId: active.operationId, writer: active.writer, phase: active.phase }
        : null
    return createHumanInputFloorClaim(suspended, {
      commit: () => {
        state.floors.pending -= 1
        state.floors.committed += 1
        return revokeActive(state, 'human-input-floor', { humanSource: source })
      },
      // Why: a claim that never landed must hand the pane back intact — a phone
      // write the runtime rejects cannot be allowed to kill a live operation.
      rollback: () => {
        state.floors.pending -= 1
        if (state.floors.pending === 0 && state.active) {
          resumeInputLease(state.active)
        }
        settle(state)
      },
      releaseCommitted: () => {
        state.floors.committed -= 1
        openQuietWindow(state)
      }
    })
  }

  return {
    acquire,
    beginHumanInputFloor,
    // A keystroke on a pane automation never leased is a no-op, not a new entry:
    // human input is the common case and must not accrete state. Nothing could be
    // leased there anyway until notePtyPin announces the incarnation.
    claimHumanInput: (ptyId, source) => {
      const state = ptys.get(ptyId)
      if (!state) {
        return null
      }
      const report = revokeActive(state, 'human-input', { humanSource: source })
      openQuietWindow(state)
      return report
    },
    notePtyPin: (ptyId, pin) => {
      const state = stateFor(ptyId)
      if (state.pin && connectionPinRewinds(state.pin, pin)) {
        reclaim(state)
        return null
      }
      state.pin = pin
      state.live = true
      const report =
        state.active && !connectionPinsEqual(state.active.pin, pin)
          ? revokeActive(state, 'generation-change', { supersededBy: pin })
          : null
      dropStaleWaiters(state, pin)
      settle(state)
      return report
    },
    disposePty: (ptyId) => {
      const state = ptys.get(ptyId)
      if (!state) {
        return null
      }
      state.live = false
      const report = revokeActive(state, 'pty-disposed')
      // The pane is gone, so no in-flight bytes are left to protect and the slot
      // frees immediately. A held human floor is *not* dropped with it: a human
      // still owns the pane, including the next incarnation of this id.
      state.active = null
      for (const waiter of state.waiters.splice(0)) {
        waiter.detach()
        waiter.resolve({ ok: false, reason: 'pty-disposed' })
      }
      state.cancelQuietWindow?.()
      state.cancelQuietWindow = null
      reclaim(state)
      return report
    },
    inspect: (ptyId) => {
      const state = ptys.get(ptyId)
      const active = state?.active ?? null
      return {
        holder: active
          ? {
              operationId: active.operationId,
              writer: active.writer,
              phase: active.phase,
              writeAuthority: inputLeaseWriteAuthority(active)
            }
          : null,
        waiting: state?.waiters.length ?? 0,
        humanFloors: state ? state.floors.pending + state.floors.committed : 0,
        humanQuietWindow: Boolean(state?.cancelQuietWindow),
        tracked: Boolean(state)
      }
    }
  }
}
