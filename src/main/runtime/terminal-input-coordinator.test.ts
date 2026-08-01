import { describe, expect, it } from 'vitest'
import {
  createTerminalInputCoordinator,
  type AcquireInputLeaseResult,
  type TerminalInputCoordinator,
  type TerminalInputLease
} from './terminal-input-coordinator'
import {
  describePreemptionOutcome,
  TerminalInputLeaseRevokedError,
  type ConnectionPin,
  type LeaseRevokedReport
} from './terminal-input-lease-preemption'

const PIN: ConnectionPin = {
  ptyIncarnationId: 'inc-1',
  connectionGeneration: 3
}
const NEXT_PIN: ConnectionPin = {
  ptyIncarnationId: 'inc-2',
  connectionGeneration: 4
}

type Harness = {
  coordinator: TerminalInputCoordinator
  /** Fires every armed §5.4 quiet window, deterministically. */
  endQuietWindows: () => void
}

function createHarness(): Harness {
  let operation = 0
  const armed = new Set<() => void>()
  const coordinator = createTerminalInputCoordinator({
    now: () => 1_700_000_000_000,
    createOperationId: () => `op-${(operation += 1)}`,
    scheduleQuietWindowEnd: (end) => {
      armed.add(end)
      return () => armed.delete(end)
    }
  })
  return {
    coordinator,
    endQuietWindows: () => {
      const firing = [...armed]
      armed.clear()
      for (const end of firing) {
        end()
      }
    }
  }
}

/** The pin authority speaks first: nothing may be leased on an unannounced pane. */
function createCoordinator(ptyIds: string[] = ['pty-1']): TerminalInputCoordinator {
  const { coordinator } = createHarness()
  for (const ptyId of ptyIds) {
    coordinator.notePtyPin(ptyId, PIN)
  }
  return coordinator
}

function expectGranted(result: AcquireInputLeaseResult): TerminalInputLease {
  if (!result.ok) {
    throw new Error(`expected a lease, got ${result.reason}`)
  }
  return result.lease
}

async function lease(
  coordinator: TerminalInputCoordinator,
  writer: 'manager' | 'coordinator-dispatch' = 'manager'
): Promise<TerminalInputLease> {
  return expectGranted(await coordinator.acquire({ ptyId: 'pty-1', pin: PIN, writer }))
}

describe('terminal input coordinator', () => {
  it('serializes two automated writers on one PTY', async () => {
    const coordinator = createCoordinator()
    const first = await lease(coordinator, 'manager')

    let secondSettled = false
    const second = coordinator
      .acquire({ ptyId: 'pty-1', pin: PIN, writer: 'coordinator-dispatch' })
      .then((result) => {
        secondSettled = true
        return result
      })
    await Promise.resolve()

    expect(secondSettled).toBe(false)
    expect(coordinator.inspect('pty-1')).toEqual({
      holder: {
        operationId: 'op-1',
        writer: 'manager',
        phase: 'acquired',
        writeAuthority: 'held'
      },
      waiting: 1,
      humanFloors: 0,
      humanQuietWindow: false,
      tracked: true
    })

    first.release()
    const granted = expectGranted(await second)
    expect(granted.writer).toBe('coordinator-dispatch')
    expect(granted.operationId).not.toBe(first.operationId)
    expect(coordinator.inspect('pty-1').waiting).toBe(0)
  })

  it('reports a clean abort when preempted before paste', async () => {
    const coordinator = createCoordinator()
    const held = await lease(coordinator)

    const report = coordinator.claimHumanInput('pty-1', 'desktop')

    expect(report).toMatchObject({
      operationId: 'op-1',
      ptyId: 'pty-1',
      writer: 'manager',
      phase: 'acquired',
      cause: 'human-input',
      humanSource: 'desktop',
      submitted: 'no',
      draftState: 'clean',
      watcher: 'stopped',
      retry: 'allowed'
    })
    expect(held.checkRevoked()).toEqual(report)
    expect(held.revoked.aborted).toBe(true)
  })

  it('reports a contaminated draft when preempted after paste and before Enter', async () => {
    const coordinator = createCoordinator()
    const held = await lease(coordinator)
    expect(held.beginPaste()).toBeNull()
    expect(held.completePaste()).toBeNull()

    const report = coordinator.claimHumanInput('pty-1', 'mobile')

    expect(report).toMatchObject({
      phase: 'pasted',
      humanSource: 'mobile',
      submitted: 'no',
      draftState: 'contaminated',
      watcher: 'stopped',
      retry: 'forbidden'
    })
  })

  // §5.2a attribution rides on the lease, so a landed Enter must never be
  // reported as un-submitted no matter what takes the pane back afterwards.
  it('leaves the verdict to the read-only watcher when preempted after Enter', async () => {
    const takeBacks: ((coordinator: TerminalInputCoordinator) => LeaseRevokedReport | null)[] = [
      (coordinator) => coordinator.claimHumanInput('pty-1', 'desktop'),
      (coordinator) => coordinator.beginHumanInputFloor('pty-1', 'mobile').commit(),
      (coordinator) => coordinator.notePtyPin('pty-1', NEXT_PIN),
      (coordinator) => coordinator.disposePty('pty-1')
    ]

    for (const takeBack of takeBacks) {
      const coordinator = createCoordinator()
      const held = await lease(coordinator)
      held.beginPaste()
      held.completePaste()
      expect(held.armSubmit()).toBeNull()

      const report = takeBack(coordinator)

      // The row §5.4 forbids collapsing: Enter landed, so the outcome belongs to
      // the read-only watcher — 'no' here would license a retry that double-sends.
      expect(report).toMatchObject({
        phase: 'submitted',
        submitted: 'unresolved',
        draftState: 'unknown',
        watcher: 'read-only',
        retry: 'forbidden'
      })
      expect(held.checkRevoked()).toEqual(report)
    }
  })

  it('maps every phase to its documented preemption outcome', () => {
    expect(describePreemptionOutcome('acquired')).toEqual({
      submitted: 'no',
      draftState: 'clean',
      watcher: 'stopped',
      retry: 'allowed'
    })
    expect(describePreemptionOutcome('pasting')).toEqual(describePreemptionOutcome('pasted'))
    expect(describePreemptionOutcome('pasting')).toMatchObject({
      submitted: 'no',
      draftState: 'contaminated'
    })
    expect(describePreemptionOutcome('submitted')).toEqual({
      submitted: 'unresolved',
      draftState: 'unknown',
      watcher: 'read-only',
      retry: 'forbidden'
    })
  })

  it('observes revocation between paste chunks and immediately before Enter', async () => {
    const { coordinator, endQuietWindows } = createHarness()
    coordinator.notePtyPin('pty-1', PIN)
    const chunked = await lease(coordinator)
    chunked.beginPaste()
    expect(chunked.checkRevoked()).toBeNull()
    coordinator.claimHumanInput('pty-1', 'desktop')

    const betweenChunks = chunked.checkRevoked()
    expect(betweenChunks).toMatchObject({
      phase: 'pasting',
      draftState: 'contaminated'
    })
    expect(() => chunked.assertStillHeld()).toThrow(TerminalInputLeaseRevokedError)
    chunked.release()
    endQuietWindows()

    const armed = await lease(coordinator)
    armed.beginPaste()
    armed.completePaste()
    coordinator.claimHumanInput('pty-1', 'mobile')

    // The pre-Enter seam must refuse the keypress, not latch 'submitted'.
    expect(armed.armSubmit()).toMatchObject({
      phase: 'pasted',
      submitted: 'no'
    })
    expect(armed.phase()).toBe('pasted')
  })

  it('aborts the active lease and drops stale waiters on a generation change', async () => {
    const coordinator = createCoordinator()
    const held = await lease(coordinator)
    held.beginPaste()
    const stale = coordinator.acquire({
      ptyId: 'pty-1',
      pin: PIN,
      writer: 'coordinator-dispatch'
    })

    const report = coordinator.notePtyPin('pty-1', NEXT_PIN)

    expect(report).toMatchObject({
      phase: 'pasting',
      cause: 'generation-change',
      supersededBy: NEXT_PIN,
      submitted: 'no',
      draftState: 'contaminated'
    })
    await expect(stale).resolves.toEqual({
      ok: false,
      reason: 'generation-change',
      currentPin: NEXT_PIN
    })
    await expect(
      coordinator.acquire({ ptyId: 'pty-1', pin: PIN, writer: 'manager' })
    ).resolves.toEqual({
      ok: false,
      reason: 'generation-change',
      currentPin: NEXT_PIN
    })
  })

  it('refuses a lease on a pane whose incarnation was never announced', async () => {
    const coordinator = createCoordinator([])

    await expect(
      coordinator.acquire({ ptyId: 'pty-1', pin: PIN, writer: 'manager' })
    ).resolves.toEqual({ ok: false, reason: 'pty-disposed' })
    // The acquirer's own pin is not evidence about the pane, so it is not adopted.
    expect(coordinator.inspect('pty-1').tracked).toBe(false)
  })

  it('refuses a superseded pin after the PTY is reincarnated under the same id', async () => {
    const coordinator = createCoordinator()
    const first = await lease(coordinator)
    coordinator.disposePty('pty-1')
    first.release()

    // Disposing must not amnesty the pin: the id is dead until the authority
    // announces the next incarnation, and the old pin never becomes valid again.
    await expect(
      coordinator.acquire({ ptyId: 'pty-1', pin: PIN, writer: 'manager' })
    ).resolves.toEqual({ ok: false, reason: 'pty-disposed' })
    coordinator.notePtyPin('pty-1', NEXT_PIN)

    // A writer still holding the pre-dispose pin would type into the new pane.
    await expect(
      coordinator.acquire({ ptyId: 'pty-1', pin: PIN, writer: 'manager' })
    ).resolves.toEqual({ ok: false, reason: 'generation-change', currentPin: NEXT_PIN })
    expect(
      expectGranted(await coordinator.acquire({ ptyId: 'pty-1', pin: NEXT_PIN, writer: 'manager' }))
        .pin
    ).toEqual(NEXT_PIN)
  })

  it('keeps the pin floor across a dispose of an otherwise-idle pane', async () => {
    const coordinator = createCoordinator()
    // Nothing else depends on this pane: no lease, no waiter, no human floor. The pin
    // is the only thing left, and it is exactly what a reordered event must not rewind.
    coordinator.notePtyPin('pty-1', NEXT_PIN)
    coordinator.disposePty('pty-1')

    coordinator.notePtyPin('pty-1', PIN)

    await expect(
      coordinator.acquire({ ptyId: 'pty-1', pin: PIN, writer: 'manager' })
    ).resolves.toEqual({ ok: false, reason: 'pty-disposed' })
  })

  it('ignores a pin that rewinds to a superseded connection generation', async () => {
    const coordinator = createCoordinator([])
    coordinator.notePtyPin('pty-1', NEXT_PIN)
    const held = expectGranted(
      await coordinator.acquire({ ptyId: 'pty-1', pin: NEXT_PIN, writer: 'manager' })
    )

    // A late event from the superseded connection: truthful-looking, backwards.
    expect(coordinator.notePtyPin('pty-1', PIN)).toBeNull()

    expect(held.checkRevoked()).toBeNull()
    expect(coordinator.inspect('pty-1').holder).toMatchObject({ writeAuthority: 'held' })
    await expect(
      coordinator.acquire({ ptyId: 'pty-1', pin: PIN, writer: 'coordinator-dispatch' })
    ).resolves.toEqual({ ok: false, reason: 'generation-change', currentPin: NEXT_PIN })
  })

  it('cancels a queued waiter without disturbing the holder', async () => {
    const coordinator = createCoordinator()
    const held = await lease(coordinator)
    const canceller = new AbortController()
    const queued = coordinator.acquire({
      ptyId: 'pty-1',
      pin: PIN,
      writer: 'message-delivery',
      signal: canceller.signal
    })

    canceller.abort()

    await expect(queued).resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(coordinator.inspect('pty-1')).toMatchObject({ waiting: 0 })
    expect(held.checkRevoked()).toBeNull()

    held.release()
    const alreadyAborted = await coordinator.acquire({
      ptyId: 'pty-1',
      pin: PIN,
      writer: 'query-reply',
      signal: canceller.signal
    })
    expect(alreadyAborted).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('does not let an already-cancelled acquire carrying a stale pin touch the pane', async () => {
    const coordinator = createCoordinator([])
    coordinator.notePtyPin('pty-1', NEXT_PIN)
    const canceller = new AbortController()
    canceller.abort()

    const cancelled = await coordinator.acquire({
      ptyId: 'pty-1',
      pin: PIN,
      writer: 'manager',
      signal: canceller.signal
    })

    // Cancelled first: the stale pin never reaches the pin comparison, let alone
    // the pane, so the live-generation writer is still served.
    expect(cancelled).toEqual({ ok: false, reason: 'cancelled' })
    const granted = expectGranted(
      await coordinator.acquire({ ptyId: 'pty-1', pin: NEXT_PIN, writer: 'coordinator-dispatch' })
    )
    expect(granted.pin).toEqual(NEXT_PIN)
  })

  it('keeps the pane closed to automation until the preempted writer acknowledges', async () => {
    const { coordinator, endQuietWindows } = createHarness()
    coordinator.notePtyPin('pty-1', PIN)
    const held = await lease(coordinator)
    held.beginPaste()
    held.completePaste()
    held.armSubmit()
    const next = coordinator.acquire({
      ptyId: 'pty-1',
      pin: PIN,
      writer: 'manager'
    })

    coordinator.claimHumanInput('pty-1', 'desktop')
    await Promise.resolve()

    // The read-only watcher is still running: in-flight bytes cannot be recalled.
    expect(coordinator.inspect('pty-1')).toMatchObject({
      holder: { operationId: 'op-1', writeAuthority: 'revoked' },
      waiting: 1
    })

    held.release()
    endQuietWindows()
    expect(expectGranted(await next).operationId).toBe('op-2')
  })

  it('ignores human input on a pane automation never leased', () => {
    const coordinator = createCoordinator([])

    expect(coordinator.claimHumanInput('pty-unknown', 'desktop')).toBeNull()
    expect(coordinator.inspect('pty-unknown')).toEqual({
      holder: null,
      waiting: 0,
      humanFloors: 0,
      humanQuietWindow: false,
      tracked: false
    })
  })

  it('fails queued waiters and revokes the holder when the PTY is disposed', async () => {
    const coordinator = createCoordinator()
    const held = await lease(coordinator)
    const queued = coordinator.acquire({
      ptyId: 'pty-1',
      pin: PIN,
      writer: 'query-reply'
    })

    const report = coordinator.disposePty('pty-1')

    expect(report).toMatchObject({
      cause: 'pty-disposed',
      phase: 'acquired',
      submitted: 'no'
    })
    await expect(queued).resolves.toEqual({
      ok: false,
      reason: 'pty-disposed'
    })
    expect(held.checkRevoked()?.cause).toBe('pty-disposed')
    // Every claim is gone; only the pin floor remains, so the dead generation can
    // never be leased again.
    expect(coordinator.inspect('pty-1')).toEqual({
      holder: null,
      waiting: 0,
      humanFloors: 0,
      humanQuietWindow: false,
      tracked: true
    })
  })

  it('keeps no per-PTY state once every claim on a pane has resolved', async () => {
    const coordinator = createCoordinator([])

    coordinator.beginHumanInputFloor('pty-ghost', 'mobile').rollback()
    expect(coordinator.inspect('pty-ghost').tracked).toBe(false)

    const canceller = new AbortController()
    canceller.abort()
    await coordinator.acquire({
      ptyId: 'pty-ghost',
      pin: PIN,
      writer: 'manager',
      signal: canceller.signal
    })
    expect(coordinator.inspect('pty-ghost').tracked).toBe(false)

    // A pane that was never announced leaves nothing behind. One that WAS announced
    // keeps its pin as a floor after dispose — bounded, and the only thing standing
    // between a reordered event and a lease on a superseded generation.
    coordinator.notePtyPin('pty-ghost', PIN)
    coordinator.disposePty('pty-ghost')
    expect(coordinator.inspect('pty-ghost').tracked).toBe(true)
  })

  it('scopes leases per PTY', async () => {
    const coordinator = createCoordinator(['pty-1', 'pty-2'])
    const first = await lease(coordinator)
    const second = expectGranted(
      await coordinator.acquire({
        ptyId: 'pty-2',
        pin: PIN,
        writer: 'manager'
      })
    )

    coordinator.claimHumanInput('pty-2', 'desktop')

    expect(first.checkRevoked()).toBeNull()
    expect(second.checkRevoked()?.ptyId).toBe('pty-2')
  })

  it('refuses phase transitions after release', async () => {
    const coordinator = createCoordinator()
    const held = await lease(coordinator)
    held.release()

    expect(() => held.beginPaste()).toThrow('Terminal input lease already released')
  })
})
