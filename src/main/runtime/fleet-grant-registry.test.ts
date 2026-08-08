import { describe, expect, it } from 'vitest'
import { FleetGrantRegistry } from './fleet-grant-registry'
import {
  FLEET_GRANT_ENV_VAR,
  containsFleetGrantEnv,
  stripFleetGrantEnv
} from '../../shared/fleet-grant'

function makeRegistry() {
  let clock = 1_000
  const registry = new FleetGrantRegistry(() => clock)
  return { registry, advance: (ms: number) => (clock += ms) }
}

const target = { handle: 'worker-1', incarnationId: 'inc_1' }

describe('FleetGrantRegistry', () => {
  it('allows the op it granted on the pane it granted', () => {
    const { registry } = makeRegistry()
    const grant = registry.issue({
      runId: 'run_1',
      generation: 0,
      ops: ['write'],
      targets: [target]
    })
    expect(
      registry.check(grant.secret, { op: 'write', handle: 'worker-1', incarnationId: 'inc_1' })
    ).toMatchObject({ allowed: true, runId: 'run_1' })
  })

  it('refuses a caller presenting nothing — the R0 default', () => {
    const { registry } = makeRegistry()
    expect(
      registry.check(null, { op: 'write', handle: 'worker-1', incarnationId: 'inc_1' })
    ).toEqual({
      allowed: false,
      reason: 'no-grant-presented'
    })
  })

  it('refuses an unknown secret', () => {
    const { registry } = makeRegistry()
    expect(
      registry.check('made-up', { op: 'write', handle: 'worker-1', incarnationId: 'inc_1' })
    ).toEqual({
      allowed: false,
      reason: 'unknown-grant'
    })
  })

  it('refuses an op the grant does not carry', () => {
    const { registry } = makeRegistry()
    const grant = registry.issue({
      runId: 'run_1',
      generation: 0,
      ops: ['read'],
      targets: [target]
    })
    expect(
      registry.check(grant.secret, { op: 'write', handle: 'worker-1', incarnationId: 'inc_1' })
    ).toEqual({ allowed: false, reason: 'op-not-granted' })
  })

  it("refuses a pane the grant does not cover — the human's own terminals", () => {
    const { registry } = makeRegistry()
    const grant = registry.issue({
      runId: 'run_1',
      generation: 0,
      ops: ['write'],
      targets: [target]
    })
    expect(
      registry.check(grant.secret, { op: 'write', handle: 'my-shell', incarnationId: 'inc_9' })
    ).toEqual({ allowed: false, reason: 'target-not-granted' })
  })

  it('refuses the same pane after it respawned — a new process was never authorized', () => {
    const { registry } = makeRegistry()
    const grant = registry.issue({
      runId: 'run_1',
      generation: 0,
      ops: ['write'],
      targets: [target]
    })
    expect(
      registry.check(grant.secret, { op: 'write', handle: 'worker-1', incarnationId: 'inc_2' })
    ).toEqual({ allowed: false, reason: 'incarnation-changed' })
  })

  it('honors a fleet-owned wildcard incarnation', () => {
    const { registry } = makeRegistry()
    const grant = registry.issue({
      runId: 'run_1',
      generation: 0,
      ops: ['write'],
      targets: [{ handle: 'worker-1', incarnationId: null }]
    })
    expect(
      registry.check(grant.secret, { op: 'write', handle: 'worker-1', incarnationId: 'anything' })
    ).toMatchObject({ allowed: true })
  })

  it('revocation takes effect immediately — this is what the pre-Enter re-check catches', () => {
    const { registry } = makeRegistry()
    const grant = registry.issue({
      runId: 'run_1',
      generation: 0,
      ops: ['write'],
      targets: [target]
    })
    const request = { op: 'write', handle: 'worker-1', incarnationId: 'inc_1' } as const
    expect(registry.check(grant.secret, request)).toMatchObject({ allowed: true })
    expect(registry.revoke(grant.grantId)).toBe(true)
    expect(registry.check(grant.secret, request)).toEqual({ allowed: false, reason: 'revoked' })
  })

  it('expires', () => {
    const { registry, advance } = makeRegistry()
    const grant = registry.issue({
      runId: 'run_1',
      generation: 0,
      ops: ['write'],
      targets: [target],
      ttlMs: 5_000
    })
    advance(5_001)
    expect(
      registry.check(grant.secret, { op: 'write', handle: 'worker-1', incarnationId: 'inc_1' })
    ).toEqual({ allowed: false, reason: 'expired' })
  })

  it('bumping the generation kills the outgoing manager before the new one exists', () => {
    const { registry } = makeRegistry()
    const grant = registry.issue({
      runId: 'run_1',
      generation: 0,
      ops: ['write'],
      targets: [target]
    })
    expect(registry.bumpGeneration('run_1')).toBe(1)
    expect(
      registry.check(grant.secret, { op: 'write', handle: 'worker-1', incarnationId: 'inc_1' })
    ).toEqual({ allowed: false, reason: 'revoked' })
  })

  it('revoking one run leaves another alone', () => {
    const { registry } = makeRegistry()
    const mine = registry.issue({
      runId: 'run_1',
      generation: 0,
      ops: ['write'],
      targets: [target]
    })
    const other = registry.issue({
      runId: 'run_2',
      generation: 0,
      ops: ['write'],
      targets: [target]
    })
    expect(registry.revokeRun('run_1')).toBe(1)
    expect(
      registry.check(other.secret, { op: 'write', handle: 'worker-1', incarnationId: 'inc_1' })
    ).toMatchObject({ allowed: true })
    expect(
      registry.check(mine.secret, { op: 'write', handle: 'worker-1', incarnationId: 'inc_1' })
    ).toEqual({ allowed: false, reason: 'revoked' })
  })

  it('does not widen a grant when the caller mutates the arrays it passed', () => {
    const { registry } = makeRegistry()
    const ops: ('read' | 'write')[] = ['read']
    const grant = registry.issue({ runId: 'run_1', generation: 0, ops, targets: [target] })
    ops.push('write')
    expect(
      registry.check(grant.secret, { op: 'write', handle: 'worker-1', incarnationId: 'inc_1' })
    ).toEqual({ allowed: false, reason: 'op-not-granted' })
  })
})

describe('stripFleetGrantEnv', () => {
  it('removes the grant a caller tried to supply', () => {
    const stripped = stripFleetGrantEnv({ [FLEET_GRANT_ENV_VAR]: 'secret', PATH: '/usr/bin' })
    expect(stripped).toEqual({ PATH: '/usr/bin' })
    expect(containsFleetGrantEnv(stripped)).toBe(false)
  })

  it('leaves an untainted bag identical', () => {
    const env = { PATH: '/usr/bin' }
    expect(stripFleetGrantEnv(env)).toBe(env)
  })

  it('tolerates undefined', () => {
    expect(stripFleetGrantEnv(undefined)).toBeUndefined()
  })
})
