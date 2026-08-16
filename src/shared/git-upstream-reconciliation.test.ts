// Moved here from `git-upstream-status.test.ts` with the cutover of both
// predicates to `orca_core::git_upstream_status`. The
// upstreamOnlyCommitsArePatchEquivalent cases live in src/relay/git-wasm.test.ts
// with that parser's own cutover.
import { describe, expect, it } from 'vitest'
import {
  isBehindOnlyUpstream,
  shouldForcePushWithLeaseForUpstream
} from './git-upstream-reconciliation'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import type { GitUpstreamStatus } from './git-status-types'

// config/vitest-orca-dispatch-seam.ts already ran initSync and bound the seam,
// so rebinding is just the callback.
const bindCore = (): void => {
  setOrcaDispatchBinding((module, fn, input) => orcaDispatch(module, fn, input))
}
const unbindCore = (): void => {
  setOrcaDispatchBinding(null)
}

describe('shouldForcePushWithLeaseForUpstream', () => {
  it('requires a diverged upstream with patch-equivalent behind commits', () => {
    expect(
      shouldForcePushWithLeaseForUpstream({
        hasUpstream: true,
        ahead: 1,
        behind: 1,
        behindCommitsArePatchEquivalent: true
      })
    ).toBe(true)
    expect(
      shouldForcePushWithLeaseForUpstream({
        hasUpstream: true,
        ahead: 1,
        behind: 1,
        behindCommitsArePatchEquivalent: false
      })
    ).toBe(false)
  })
})

describe('isBehindOnlyUpstream', () => {
  it('is true only when the branch tracks upstream and is purely behind', () => {
    expect(
      isBehindOnlyUpstream({
        hasUpstream: true,
        ahead: 0,
        behind: 3
      })
    ).toBe(true)
    expect(
      isBehindOnlyUpstream({
        hasUpstream: true,
        ahead: 1,
        behind: 2
      })
    ).toBe(false)
    expect(
      isBehindOnlyUpstream({
        hasUpstream: true,
        ahead: 0,
        behind: 0
      })
    ).toBe(false)
    expect(
      isBehindOnlyUpstream({
        hasUpstream: false,
        ahead: 0,
        behind: 3
      })
    ).toBe(false)
    expect(isBehindOnlyUpstream(undefined)).toBe(false)
  })
})

// The deleted twin's bodies, kept as the oracle the sweep below compares against.
function twinShouldForcePush(status: GitUpstreamStatus | undefined): boolean {
  return (
    status?.hasUpstream === true &&
    status.ahead > 0 &&
    status.behind > 0 &&
    status.behindCommitsArePatchEquivalent === true
  )
}
function twinIsBehindOnly(status: GitUpstreamStatus | undefined): boolean {
  return status?.hasUpstream === true && status.ahead === 0 && status.behind > 0
}

const COUNTERS: unknown[] = [
  0, 1, 2, 3, 100, -1, -2, 9007199254740991, -9007199254740991, 9007199254740992,
  0.5, -0.5, 1.5, 1e21, 2 ** 60, 9223372036854775808, Number.MAX_VALUE, -0,
  Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null,
  '0', '3', '', ' 2 ', 'abc', true, false, [], [5], [0], {}
]
const FLAGS: unknown[] = [true, false, undefined, null, 1, 0, 'true', '', {}]
const NON_RECORDS: unknown[] = [undefined, null, 'x', '', 0, 5, true, false, [], [1, 2]]

type Probe = { label: string; status: unknown }

function probes(): Probe[] {
  const out: Probe[] = NON_RECORDS.map((status) => ({
    label: `non-record ${String(status)}`,
    status
  }))
  for (const hasUpstream of FLAGS) {
    for (const ahead of COUNTERS) {
      for (const behind of COUNTERS) {
        for (const behindCommitsArePatchEquivalent of [true, false, undefined]) {
          out.push({
            label: `hasUpstream=${String(hasUpstream)} ahead=${String(ahead)} behind=${String(behind)} equivalent=${String(behindCommitsArePatchEquivalent)}`,
            // upstreamName rides along on every probe: the core never reads it
            // for these predicates and the shim must never put it on the wire.
            status: {
              hasUpstream,
              ahead,
              behind,
              behindCommitsArePatchEquivalent,
              upstreamName: 'origin/main'
            }
          })
        }
      }
    }
  }
  for (const behindCommitsArePatchEquivalent of FLAGS) {
    out.push({
      label: `patch-equivalence flag ${String(behindCommitsArePatchEquivalent)}`,
      status: { hasUpstream: true, ahead: 2, behind: 3, behindCommitsArePatchEquivalent }
    })
  }
  // Values `encodeDispatchPayload` refuses, all on fields the core never reads —
  // they must not reach the encoder, or a real answer lands on the fallback.
  const cyclic: Record<string, unknown> = { hasUpstream: true, ahead: 0, behind: 3 }
  cyclic.self = cyclic
  return [
    ...out,
    {
      label: 'lone surrogate in upstreamName',
      status: { hasUpstream: true, ahead: 0, behind: 3, upstreamName: 'origin/\ud800bad' }
    },
    {
      label: 'lone surrogate on a diverged status',
      status: {
        hasUpstream: true,
        ahead: 2,
        behind: 3,
        behindCommitsArePatchEquivalent: true,
        upstreamName: '\udfff'
      }
    },
    { label: 'cyclic sibling key', status: cyclic },
    {
      label: 'Date-prototype status',
      status: Object.assign(new Date(), { hasUpstream: true, ahead: 0, behind: 3 })
    },
    {
      label: 'toJSON sibling',
      status: { hasUpstream: true, ahead: 0, behind: 3, toJSON: () => ({}) }
    },
    { label: 'bigint sibling', status: { hasUpstream: true, ahead: 0, behind: 3, extra: 10n } },
    {
      label: 'symbol-keyed sibling',
      status: { hasUpstream: true, ahead: 0, behind: 3, [Symbol('s')]: 1 }
    }
  ]
}

const PROBES = probes()

function divergences(): string[] {
  const bad: string[] = []
  for (const probe of PROBES) {
    const status = probe.status as GitUpstreamStatus | undefined
    const want = `${twinShouldForcePush(status)}/${twinIsBehindOnly(status)}`
    let got: string
    try {
      got = `${shouldForcePushWithLeaseForUpstream(status)}/${isBehindOnlyUpstream(status)}`
    } catch (error) {
      got = `threw ${(error as Error).name}: ${(error as Error).message.slice(0, 80)}`
    }
    if (got !== want) {
      bad.push(`${probe.label}: twin ${want}, shim ${got}`)
    }
  }
  return bad
}

// Trap 4 of the migration: a fallback-vs-core differential cannot see a
// divergence that only exists once the seam is BOUND, so both states are swept
// against the twin, not against each other. Watched failing: relaxing the
// counter guard to `Number.isFinite` reddens 224 of these, and admitting an
// absent/null counter reddens 30 — the `{hasUpstream: true, behind: N}` class
// the shipped i64 core answers TRUE and the twin answers false.
describe('every probe answers the twin in BOTH seam states', () => {
  it('unbound — mobile, the preload, and the renderer before wasm init', () => {
    unbindCore()
    expect(divergences()).toEqual([])
  })

  it('bound to the shipped core', () => {
    bindCore()
    expect(divergences()).toEqual([])
  })
})

// The other half of the guard, and the reason it exists: the SHIPPED
// orca_git_wasm_bg.wasm / orca_node.node predate 25d68c0562 and still read the
// counters with `as_i64().unwrap_or(0)`. When the blobs are rebuilt onto the f64
// core these turn red — re-derive the guard then instead of leaving it to
// outlive its reason.
describe('the raw core still disagrees with the twin on the guarded classes', () => {
  const raw = (fn: string, status: unknown): unknown =>
    JSON.parse(orcaDispatch('git-upstream-status', fn, JSON.stringify(status)))

  it('reads an absent counter as a real zero', () => {
    const absentAhead = { hasUpstream: true, behind: 4 }
    expect(twinIsBehindOnly(absentAhead as GitUpstreamStatus)).toBe(false)
    expect(raw('isBehindOnlyUpstream', absentAhead)).toBe(true)
    bindCore()
    expect(isBehindOnlyUpstream(absentAhead as GitUpstreamStatus)).toBe(false)
  })

  it('reads a null counter as a real zero', () => {
    const nullAhead = { hasUpstream: true, ahead: null, behind: 4 }
    expect(twinIsBehindOnly(nullAhead as unknown as GitUpstreamStatus)).toBe(false)
    expect(raw('isBehindOnlyUpstream', nullAhead)).toBe(true)
    bindCore()
    expect(isBehindOnlyUpstream(nullAhead as unknown as GitUpstreamStatus)).toBe(false)
  })

  it('reads a fractional counter as a real zero', () => {
    const fractional = { hasUpstream: true, ahead: 0, behind: 0.5 }
    expect(twinIsBehindOnly(fractional)).toBe(true)
    expect(raw('isBehindOnlyUpstream', fractional)).toBe(false)
    bindCore()
    expect(isBehindOnlyUpstream(fractional)).toBe(true)
  })

  it('reads a past-i64 counter as a real zero', () => {
    const huge = { hasUpstream: true, ahead: 2, behind: 9223372036854775808, behindCommitsArePatchEquivalent: true }
    expect(twinShouldForcePush(huge)).toBe(true)
    expect(raw('shouldForcePushWithLeaseForUpstream', huge)).toBe(false)
    bindCore()
    expect(shouldForcePushWithLeaseForUpstream(huge)).toBe(true)
  })
})
