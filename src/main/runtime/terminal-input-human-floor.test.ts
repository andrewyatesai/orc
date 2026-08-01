import { describe, expect, it } from 'vitest'
import {
  createTerminalInputCoordinator,
  type AcquireInputLeaseResult,
  type TerminalInputCoordinator,
  type TerminalInputLease
} from './terminal-input-coordinator'
import { createHumanInputFloorClaim } from './terminal-input-human-floor'
import {
  TerminalInputLeaseSuspendedError,
  type ConnectionPin
} from './terminal-input-lease-preemption'

const PIN: ConnectionPin = { ptyIncarnationId: 'inc-1', connectionGeneration: 3 }
const NEXT_PIN: ConnectionPin = { ptyIncarnationId: 'inc-2', connectionGeneration: 4 }

type Harness = {
  coordinator: TerminalInputCoordinator
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
  coordinator.notePtyPin('pty-1', PIN)
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

function expectGranted(result: AcquireInputLeaseResult): TerminalInputLease {
  if (!result.ok) {
    throw new Error(`expected a lease, got ${result.reason}`)
  }
  return result.lease
}

async function lease(coordinator: TerminalInputCoordinator): Promise<TerminalInputLease> {
  return expectGranted(await coordinator.acquire({ ptyId: 'pty-1', pin: PIN, writer: 'manager' }))
}

function queueWriter(coordinator: TerminalInputCoordinator): {
  granted: () => boolean
  result: Promise<AcquireInputLeaseResult>
} {
  let settled = false
  const result = coordinator
    .acquire({ ptyId: 'pty-1', pin: PIN, writer: 'coordinator-dispatch' })
    .then((value) => {
      settled = true
      return value
    })
  return { granted: () => settled, result }
}

describe('human input floor claim', () => {
  it('reserves the pane before the human write lands and revokes only on commit', async () => {
    const { coordinator, endQuietWindows } = createHarness()
    const held = await lease(coordinator)
    held.beginPaste()

    const claim = coordinator.beginHumanInputFloor('pty-1', 'mobile')

    expect(claim.suspended).toEqual({
      operationId: 'op-1',
      writer: 'manager',
      phase: 'pasting'
    })
    // Reserved, not lost: nothing has been written by the human yet.
    expect(held.writeAuthority()).toBe('suspended')
    expect(held.checkRevoked()).toBeNull()

    const report = claim.commit()

    expect(report).toMatchObject({
      cause: 'human-input-floor',
      humanSource: 'mobile',
      phase: 'pasting',
      draftState: 'contaminated',
      retry: 'forbidden'
    })
    expect(held.checkRevoked()).toEqual(report)
    held.release()

    const queued = queueWriter(coordinator)
    await Promise.resolve()
    expect(queued.granted()).toBe(false)
    expect(coordinator.inspect('pty-1')).toMatchObject({ holder: null, humanFloors: 1 })

    claim.release()
    endQuietWindows()
    expect(expectGranted(await queued.result).writer).toBe('coordinator-dispatch')
  })

  it('hands the pane back to a live operation when the human write never lands', async () => {
    const { coordinator } = createHarness()
    const held = await lease(coordinator)
    held.beginPaste()

    const claim = coordinator.beginHumanInputFloor('pty-1', 'mobile')
    const resumed = held.awaitWriteAuthority()
    // A suspended writer must not emit bytes; the seam says so loudly.
    expect(() => held.completePaste()).toThrow(TerminalInputLeaseSuspendedError)

    claim.rollback()

    await expect(resumed).resolves.toBeNull()
    expect(held.writeAuthority()).toBe('held')
    expect(held.checkRevoked()).toBeNull()
    // The operation is intact: it can finish the paste it was in the middle of.
    expect(held.completePaste()).toBeNull()
    expect(held.armSubmit()).toBeNull()
    expect(coordinator.inspect('pty-1')).toMatchObject({
      holder: { operationId: 'op-1', writeAuthority: 'held' },
      humanFloors: 0
    })
  })

  it('keeps the pane suspended while a second claim is still undecided', async () => {
    const { coordinator } = createHarness()
    const held = await lease(coordinator)

    const first = coordinator.beginHumanInputFloor('pty-1', 'mobile')
    const second = coordinator.beginHumanInputFloor('pty-1', 'mobile')
    first.rollback()

    expect(held.writeAuthority()).toBe('suspended')
    expect(coordinator.inspect('pty-1').humanFloors).toBe(1)

    second.rollback()
    expect(held.writeAuthority()).toBe('held')
  })

  it('rolls back a claim dropped without a decision so the pane cannot park forever', async () => {
    const { coordinator } = createHarness()
    const held = await lease(coordinator)

    coordinator.beginHumanInputFloor('pty-1', 'mobile').release()

    expect(held.writeAuthority()).toBe('held')
    expect(coordinator.inspect('pty-1')).toMatchObject({ humanFloors: 0, humanQuietWindow: false })
  })

  it('resolves a suspended writer with the report when a different cause revokes it', async () => {
    const { coordinator } = createHarness()
    const held = await lease(coordinator)
    const claim = coordinator.beginHumanInputFloor('pty-1', 'mobile')
    const resumed = held.awaitWriteAuthority()

    const report = coordinator.disposePty('pty-1')

    await expect(resumed).resolves.toEqual(report)
    expect(report).toMatchObject({ cause: 'pty-disposed' })
    claim.rollback()
    expect(held.writeAuthority()).toBe('revoked')
  })

  it('keeps a held human floor across a dispose and the next incarnation', async () => {
    const { coordinator, endQuietWindows } = createHarness()
    const claim = coordinator.beginHumanInputFloor('pty-1', 'mobile')
    claim.commit()

    coordinator.disposePty('pty-1')
    // §5.1: mobile is a human path that outranks automation, and a lifecycle call
    // is not consent to hand the pane to a manager the human just took it from.
    expect(coordinator.inspect('pty-1')).toMatchObject({ humanFloors: 1, tracked: true })
    coordinator.notePtyPin('pty-1', NEXT_PIN)

    let granted = false
    const parked = coordinator
      .acquire({ ptyId: 'pty-1', pin: NEXT_PIN, writer: 'manager' })
      .then((result) => {
        granted = true
        return result
      })
    await Promise.resolve()
    expect(granted).toBe(false)

    claim.release()
    endQuietWindows()
    expect(expectGranted(await parked).writer).toBe('manager')
    expect(coordinator.inspect('pty-1').humanFloors).toBe(0)
  })

  it('holds automation off for a quiet window after a human keystroke', async () => {
    const { coordinator, endQuietWindows } = createHarness()
    const held = await lease(coordinator)
    const queued = queueWriter(coordinator)

    coordinator.claimHumanInput('pty-1', 'desktop')
    held.release()
    await Promise.resolve()

    // §5.4: the human owns the keyboard for a beat, or the queued writer pastes
    // over the line they are still typing.
    expect(queued.granted()).toBe(false)
    expect(coordinator.inspect('pty-1')).toMatchObject({
      holder: null,
      humanQuietWindow: true
    })

    endQuietWindows()
    await expect(queued.result.then((result) => result.ok)).resolves.toBe(true)
    expect(coordinator.inspect('pty-1').humanQuietWindow).toBe(false)
  })

  it('restarts the quiet window on every keystroke', () => {
    const armed: (() => void)[] = []
    const coordinator = createTerminalInputCoordinator({
      // A canceller that does nothing, so a superseded timer still fires late.
      scheduleQuietWindowEnd: (end) => {
        armed.push(end)
        return () => {}
      }
    })
    coordinator.notePtyPin('pty-1', PIN)

    coordinator.claimHumanInput('pty-1', 'desktop')
    coordinator.claimHumanInput('pty-1', 'desktop')

    expect(armed).toHaveLength(2)
    armed[0]?.()
    expect(coordinator.inspect('pty-1').humanQuietWindow).toBe(true)
    armed[1]?.()
    expect(coordinator.inspect('pty-1').humanQuietWindow).toBe(false)
  })

  it('runs its three states once each', () => {
    const calls: string[] = []
    const claim = createHumanInputFloorClaim(null, {
      commit: () => {
        calls.push('commit')
        return null
      },
      rollback: () => calls.push('rollback'),
      releaseCommitted: () => calls.push('release')
    })

    claim.commit()
    claim.commit()
    claim.rollback()
    claim.release()
    claim.release()

    expect(calls).toEqual(['commit', 'release'])
  })
})
