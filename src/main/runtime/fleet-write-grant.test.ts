/**
 * §6.6 for `terminal.send` and `terminal.key`.
 *
 * These matter because a grant that only guards `submitAgentPrompt` is
 * decorative: `send --enter` and `key Enter` submit a turn just as surely, so a
 * caller holding the shared runtime token could drive an agent pane around both
 * of the submit checks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'

const PTY_ID = 'pty-write-grant'
const HANDLE = 'h-write-grant'

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean }
  ) => { launchAgent: string | null; incarnationId?: string }
  handleByPtyId: Map<string, string>
}

function runtimeWithPane(agent: string | null): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  const internals = runtime as unknown as RuntimeInternals
  const pty = internals.recordPtyWorktree(PTY_ID, 'wt-1', { connected: true })
  pty.launchAgent = agent
  // A real process incarnation: fleet grants pin to this field and FAIL CLOSED
  // without it, because an unknown incarnation cannot prove a respawn.
  pty.incarnationId = 'inc_1'
  internals.handleByPtyId.set(PTY_ID, HANDLE)
  runtime.onPtySpawned(PTY_ID, undefined, { awaitsRegistration: false })
  return runtime
}

describe('assertFleetWriteGrant', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('is inert while the fleet experiment is off — shipped behaviour is unchanged', () => {
    const runtime = runtimeWithPane('claude')
    expect(() => runtime.assertFleetWriteGrant(HANDLE, {})).not.toThrow()
  })

  describe('with the experiment on', () => {
    beforeEach(() => {
      vi.stubEnv('ORCA_EXPERIMENTAL_ORCHESTRATION', '1')
    })

    it('refuses an ungranted caller on an agent pane', () => {
      const runtime = runtimeWithPane('claude')
      expect(() => runtime.assertFleetWriteGrant(HANDLE, {})).toThrow(/grant/i)
    })

    it('allows a granted caller', () => {
      const runtime = runtimeWithPane('claude')
      const grant = runtime.issueFleetGrant({
        runId: 'run_1',
        ops: ['write'],
        terminals: [HANDLE]
      })
      expect(() => runtime.assertFleetWriteGrant(HANDLE, { grant: grant.secret })).not.toThrow()
    })

    it('exempts mobile — a person grabbing a runaway agent needs no grant (§5.1)', () => {
      const runtime = runtimeWithPane('claude')
      expect(() => runtime.assertFleetWriteGrant(HANDLE, { clientType: 'mobile' })).not.toThrow()
    })

    it('does not gate a pane running no agent', () => {
      const runtime = runtimeWithPane(null)
      expect(() => runtime.assertFleetWriteGrant(HANDLE, {})).not.toThrow()
    })

    it('refuses once the grant is revoked', () => {
      const runtime = runtimeWithPane('claude')
      const grant = runtime.issueFleetGrant({
        runId: 'run_1',
        ops: ['write'],
        terminals: [HANDLE]
      })
      expect(runtime.revokeFleetGrant(grant.grantId)).toBe(true)
      expect(() => runtime.assertFleetWriteGrant(HANDLE, { grant: grant.secret })).toThrow(
        /revoked/i
      )
    })

    it('refuses a grant issued for a different terminal', () => {
      const runtime = runtimeWithPane('claude')
      const grant = runtime.issueFleetGrant({
        runId: 'run_1',
        ops: ['write'],
        terminals: [HANDLE],
        anyIncarnation: true
      })
      expect(() =>
        runtime.assertFleetWriteGrant('someone-elses-shell', { grant: grant.secret })
      ).not.toThrow() // unresolvable handle defers to the verb's own resolution
      expect(() => runtime.assertFleetWriteGrant(HANDLE, { grant: 'not-a-real-secret' })).toThrow()
    })
  })
})
