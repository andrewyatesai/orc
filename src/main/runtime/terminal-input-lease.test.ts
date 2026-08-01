import { describe, expect, it } from 'vitest'
import {
  createInputLeaseHandle,
  createInputLeaseRecord,
  inputLeaseWriteAuthority,
  resumeInputLease,
  revokeInputLease,
  suspendInputLease,
  type InputLeaseRecord
} from './terminal-input-lease'
import {
  TerminalInputLeaseRevokedError,
  TerminalInputLeaseSuspendedError,
  type ConnectionPin
} from './terminal-input-lease-preemption'

const PIN: ConnectionPin = { ptyIncarnationId: 'inc-1', connectionGeneration: 3 }

function createRecord(): InputLeaseRecord {
  return createInputLeaseRecord({
    operationId: 'op-1',
    ptyId: 'pty-1',
    writer: 'manager',
    pin: PIN
  })
}

/** A wait composed on `revoked`, the way an echo-settle races revocation. */
function raceOnRevoked(signal: AbortSignal): Promise<'unwound'> {
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve('unwound'), { once: true })
  })
}

describe('terminal input lease', () => {
  it('unwinds waits and stops claiming write authority once released', async () => {
    const record = createRecord()
    const lease = createInputLeaseHandle(record, () => {})
    const settling = raceOnRevoked(lease.revoked)

    lease.release()

    // Without this the echo-settle wait never settles on the normal path.
    const outcome = await Promise.race([
      settling,
      new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 0))
    ])
    expect(outcome).toBe('unwound')
    expect(lease.writeAuthority()).toBe('released')
    // Nothing was preempted, so there is no report to invent.
    expect(lease.checkRevoked()).toBeNull()
    expect(() => lease.assertStillHeld()).toThrow('Terminal input lease already released')
  })

  it('reports revocation rather than release when it was preempted first', async () => {
    const record = createRecord()
    const lease = createInputLeaseHandle(record, () => {})
    revokeInputLease(record, { cause: 'human-input', at: 1, humanSource: 'desktop' })

    lease.release()

    expect(lease.writeAuthority()).toBe('revoked')
    expect(lease.checkRevoked()).toMatchObject({ cause: 'human-input' })
    expect(() => lease.assertStillHeld()).toThrow(TerminalInputLeaseRevokedError)
    await expect(lease.awaitWriteAuthority()).resolves.toMatchObject({ cause: 'human-input' })
  })

  it('withdraws authority on suspension and returns it on resume', async () => {
    const record = createRecord()
    const lease = createInputLeaseHandle(record, () => {})
    lease.beginPaste()

    suspendInputLease(record, 'mobile')

    expect(inputLeaseWriteAuthority(record)).toBe('suspended')
    expect(lease.checkRevoked()).toBeNull()
    expect(() => lease.armSubmit()).toThrow(TerminalInputLeaseSuspendedError)
    expect(record.phase).toBe('pasting')

    const resumed = lease.awaitWriteAuthority()
    resumeInputLease(record)

    await expect(resumed).resolves.toBeNull()
    expect(lease.writeAuthority()).toBe('held')
  })

  it('resolves a suspended writer with the report once the claim commits', async () => {
    const record = createRecord()
    const lease = createInputLeaseHandle(record, () => {})
    suspendInputLease(record, 'mobile')
    const resumed = lease.awaitWriteAuthority()

    const report = revokeInputLease(record, {
      cause: 'human-input-floor',
      at: 2,
      humanSource: 'mobile'
    })

    await expect(resumed).resolves.toEqual(report)
    // A late rollback cannot resurrect an operation the human already took.
    resumeInputLease(record)
    expect(lease.writeAuthority()).toBe('revoked')
  })

  it('keeps the first cause and never re-stamps a report', () => {
    const record = createRecord()
    const first = revokeInputLease(record, { cause: 'human-input', at: 1, humanSource: 'mobile' })

    expect(revokeInputLease(record, { cause: 'pty-disposed', at: 2 })).toBeNull()
    expect(record.report).toEqual(first)
  })
})
