// The feature-tips twin's tests, moved with the implementation onto the seam
// shim. Every case runs TWICE — with the dispatch seam unbound (the renderer
// before wasm init, and the whole session if wasm FAILED) and bound to the wasm
// core (main/cli via napi, the relay via initSync) — because these answers are
// persisted and never re-derived: the seen-id list is written back through
// `window.api.ui.set`, and the first tip of the ordered list is marked SEEN the
// moment it is shown, which suppresses that tip forever.
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS, type FeatureTipId } from './feature-tips'
import {
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips,
  isFeatureTipId,
  normalizeFeatureTipIds
} from './feature-tip-selection'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

/** A Set is a real return shape here, so serialize it as the ordered list the
 *  callers and the parity harness actually consume. */
function snapshot(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry) => (entry instanceof Set ? [...entry] : entry)) ??
    'undefined'
  )
}

/** Run `call` unbound and bound, assert the two agree, and return the answer. */
function agrees(call: () => unknown, label: string): string {
  setOrcaDispatchBinding(null)
  const preReady = snapshot(call())
  bindWasm()
  const ready = snapshot(call())
  setOrcaDispatchBinding(null)
  expect(preReady, `pre-ready != ready for ${label}`).toBe(ready)
  return ready
}

/** Run `call` unbound and bound; assert both equal `expected`. */
function bothStates(call: () => unknown, expected: unknown): void {
  expect(agrees(call, 'case')).toBe(snapshot(expected))
}

const TIP_IDS: readonly FeatureTipId[] = ['orca-cli', 'cmd-j-palette', 'voice-dictation']

function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((acc, item) => [...acc, ...acc.map((set) => [...set, item])], [[]])
}

// The twin's own cases, unchanged apart from running in both seam states.
describe('feature tips', () => {
  it('orders new unseen tips before older unseen tips', () => {
    bothStates(
      () => getOrderedUnseenFeatureTips({ seenTipIds: new Set() }).map((tip) => tip.id),
      ['orca-cli', 'cmd-j-palette', 'voice-dictation']
    )
  })

  it('skips tips the user has already seen', () => {
    bothStates(
      () =>
        getOrderedUnseenFeatureTips({
          seenTipIds: new Set<FeatureTipId>(['voice-dictation', 'orca-cli', 'cmd-j-palette'])
        }).map((tip) => tip.id),
      []
    )
  })

  it('skips tips for features the user has already completed', () => {
    bothStates(
      () =>
        getOrderedUnseenFeatureTips({
          // cmd-j is a seen-based tip with no feature completion, so mark it seen here.
          seenTipIds: new Set<FeatureTipId>(['cmd-j-palette']),
          completedTipIds: getCompletedFeatureTipIds({
            cliInstalled: true,
            voiceDictationEnabled: true
          })
        }).map((tip) => tip.id),
      []
    )
  })

  it('skips the CLI tip when the CLI is already installed', () => {
    bothStates(
      () =>
        getOrderedUnseenFeatureTips({
          seenTipIds: new Set<FeatureTipId>(['voice-dictation', 'cmd-j-palette']),
          completedTipIds: getCompletedFeatureTipIds({
            cliInstalled: true,
            voiceDictationEnabled: false
          })
        }).map((tip) => tip.id),
      []
    )
  })

  it('skips tips for features the user has already interacted with', () => {
    bothStates(
      () =>
        getOrderedUnseenFeatureTips({
          seenTipIds: new Set<FeatureTipId>(),
          completedTipIds: getCompletedFeatureTipIds({
            cliInstalled: false,
            voiceDictationEnabled: false,
            featureInteractions: {
              'voice-dictation': { firstInteractedAt: 100, interactionCount: 1 }
            }
          })
        }).map((tip) => tip.id),
      ['orca-cli', 'cmd-j-palette']
    )
  })

  it('normalizes persisted tip ids', () => {
    bothStates(
      () =>
        normalizeFeatureTipIds([
          'feature-tour',
          'orca-cli',
          'bogus',
          'cmd-j-palette',
          'voice-dictation'
        ]),
      ['orca-cli', 'cmd-j-palette', 'voice-dictation']
    )
  })

  it('describes the command palette tip as a passive acknowledgement', () => {
    const paletteTip = FEATURE_TIPS.find((tip) => tip.id === 'cmd-j-palette')

    expect(paletteTip).toMatchObject({
      action: 'learn-cmd-j-palette',
      priority: 'new',
      eyebrow: 'Tip',
      ctaLabel: 'Got it'
    })
    expect(paletteTip?.description).toContain('worktrees')
    expect(paletteTip?.description).toContain('spin up a new worktree')
  })

  it('describes the CLI tip as an install action with concrete workflows', () => {
    const cliTip = FEATURE_TIPS.find((tip) => tip.id === 'orca-cli')

    expect(cliTip).toMatchObject({
      action: 'setup-cli',
      title: 'Let agents drive Orca with the Orca CLI',
      ctaLabel: 'Install CLI & Skills'
    })
    expect(cliTip?.description).toContain('coordinate child worktrees')
    expect(cliTip?.description).toContain('communicate between worktrees')
  })

  it('does not label the voice dictation tip as new', () => {
    const voiceTip = FEATURE_TIPS.find((tip) => tip.id === 'voice-dictation')

    expect(voiceTip?.eyebrow).toBe('Tip')
    expect(voiceTip?.priority).toBe('unseen')
  })
})

// The pre-ready proof. `parity` is only honest if the fallback is the ready
// answer for EVERY input, so these enumerate the input space rather than sample
// it — a misordered or over-long list here is a tip suppressed forever.
describe('pre-ready equals ready (exhaustive)', () => {
  it('agrees on all 72 seen-set x completed-set combinations', () => {
    const seenSets = subsets(TIP_IDS)
    const completedSets: (FeatureTipId[] | undefined)[] = [...subsets(TIP_IDS), undefined]
    let compared = 0
    for (const seen of seenSets) {
      for (const completed of completedSets) {
        agrees(
          () =>
            getOrderedUnseenFeatureTips({
              seenTipIds: new Set(seen),
              completedTipIds: completed ? new Set(completed) : undefined
            }),
          `seen=${seen.join('|')} completed=${completed?.join('|') ?? 'absent'}`
        )
        compared += 1
      }
    }
    expect(compared).toBe(72)
  })

  it('agrees when the seen set carries members the catalog never had', () => {
    // Only catalog ids cross (narrowing 1), so an id off the wire — including one
    // the codec would refuse outright — cannot change the answer or the path.
    const junk = ['bogus', '', 'orca-cli ', '\ud800'] as unknown as FeatureTipId[]
    expect(
      agrees(
        () => getOrderedUnseenFeatureTips({ seenTipIds: new Set([...junk, 'orca-cli']) }),
        'junk seen set'
      )
    ).toBe(snapshot(FEATURE_TIPS.filter((tip) => tip.id !== 'orca-cli')))
  })

  it('agrees on the completion state over the truthiness and record spread', () => {
    const flags: unknown[] = [true, false, undefined, null, 0, 1, '', 'yes', Number.NaN]
    const interactionStates: unknown[] = [
      undefined,
      null,
      {},
      { 'voice-dictation': { firstInteractedAt: 100, interactionCount: 1 } },
      { 'voice-dictation': { firstInteractedAt: 0, interactionCount: 0 } },
      { 'voice-dictation': { firstInteractedAt: -1, interactionCount: 1 } },
      { 'voice-dictation': { firstInteractedAt: 1.5, interactionCount: 2.5 } },
      { 'voice-dictation': { firstInteractedAt: 1e21, interactionCount: 1e21 } },
      { 'voice-dictation': { firstInteractedAt: '100', interactionCount: 1 } },
      { 'voice-dictation': {} },
      { 'voice-dictation': null },
      { 'voice-dictation': [] },
      { 'voice-dictation': 'yes' },
      // -0 and Number.NaN are refused by the codec, so these prove the local answer the
      // shim falls back to is the one the core would have given.
      { 'voice-dictation': { firstInteractedAt: -0, interactionCount: 1 } },
      { 'voice-dictation': { firstInteractedAt: Number.NaN, interactionCount: 1 } },
      // Unread keys: narrowing 2 keeps them off the wire entirely.
      { browser: { firstInteractedAt: 100, interactionCount: 1 } },
      { browser: { firstInteractedAt: 100, note: '\ud800' } },
      { 'voice-dictation': { firstInteractedAt: 5 }, browser: { firstInteractedAt: '\ud800' } },
      'not an object',
      ['voice-dictation'],
      42
    ]
    let compared = 0
    for (const cliInstalled of flags) {
      for (const voiceDictationEnabled of flags) {
        for (const featureInteractions of interactionStates) {
          agrees(
            () =>
              getCompletedFeatureTipIds({
                cliInstalled,
                voiceDictationEnabled,
                featureInteractions
              } as unknown as Parameters<typeof getCompletedFeatureTipIds>[0]),
            `cli=${String(cliInstalled)} voice=${String(voiceDictationEnabled)} interactions=${JSON.stringify(featureInteractions) ?? 'undefined'}`
          )
          compared += 1
        }
      }
    }
    expect(compared).toBe(flags.length * flags.length * interactionStates.length)
  })

  it('agrees on every id list up to length three, plus the shapes JSON is not', () => {
    const alphabet: unknown[] = [...TIP_IDS, 'bogus', 42, null]
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    // A hole, built without literal elision so no lint rule has to be disabled.
    const sparse: unknown[] = ['orca-cli']
    sparse[2] = 'voice-dictation'
    const lists: unknown[] = [
      undefined,
      null,
      'nope',
      42,
      true,
      {},
      new Set(TIP_IDS),
      new Map(),
      new Date(0),
      [-0],
      ['\ud800'],
      ['orca-cli', undefined],
      sparse,
      [cycle],
      [['orca-cli']],
      Object.assign(['orca-cli'], { extra: 1 })
    ]
    for (const first of [undefined, ...alphabet]) {
      for (const second of [undefined, ...alphabet]) {
        for (const third of [undefined, ...alphabet]) {
          lists.push([first, second, third].filter((item) => item !== undefined))
        }
      }
    }
    let compared = 0
    for (const list of lists) {
      agrees(() => normalizeFeatureTipIds(list), `normalize list #${compared}`)
      compared += 1
    }
    expect(compared).toBe(lists.length)
  })

  it('agrees on the id predicate for ids, near misses and non-strings', () => {
    const values: unknown[] = [
      ...TIP_IDS,
      'bogus',
      '',
      ' orca-cli',
      'ORCA-CLI',
      'orca-cli\ud800',
      '\ud800',
      42,
      -0,
      null,
      undefined,
      true,
      {},
      [],
      ['orca-cli'],
      new Date(0),
      new Set(),
      Symbol('orca-cli'),
      BigInt(10)
    ]
    for (const value of values) {
      agrees(() => isFeatureTipId(value), `isFeatureTipId ${String(value)}`)
    }
  })
})

describe('the dispatch seam is really the implementation', () => {
  it('routes each export to its orca_config::feature_tips function', () => {
    const calls: [string, string][] = []
    setOrcaDispatchBinding((module, fn, inputJson) => {
      calls.push([module, fn])
      return orcaDispatch(module, fn, inputJson)
    })

    isFeatureTipId('orca-cli')
    normalizeFeatureTipIds(['orca-cli'])
    getCompletedFeatureTipIds({ cliInstalled: true, voiceDictationEnabled: false })
    getOrderedUnseenFeatureTips({ seenTipIds: new Set() })
    setOrcaDispatchBinding(null)

    expect(calls).toEqual([
      ['feature-tips', 'isFeatureTipId'],
      ['feature-tips', 'normalizeFeatureTipIds'],
      ['feature-tips', 'getCompletedFeatureTipIds'],
      ['feature-tips', 'getOrderedUnseenFeatureTips']
    ])
  })

  it('propagates a core failure instead of degrading to the local body', () => {
    setOrcaDispatchBinding(() => '{"__dispatch_error__":"unknown module"}')
    expect(() => normalizeFeatureTipIds(['orca-cli'])).toThrow(/failed in the Rust core/)
    setOrcaDispatchBinding(null)
  })

  it('answers a codec-refused persisted list locally instead of throwing', () => {
    // JSON.stringify emits a lone surrogate as `"\ud800"` — valid JSON text that
    // is not valid UTF-8, so the codec refuses the WHOLE payload before it
    // crosses. The twin still read the valid ids out of that same list, so the
    // fallback has to as well, or one bad element would empty the seen list.
    const binding = vi.fn((module: string, fn: string, inputJson: string) =>
      orcaDispatch(module, fn, inputJson)
    )
    setOrcaDispatchBinding(binding)
    expect(normalizeFeatureTipIds(['\ud800', 'orca-cli'])).toEqual(['orca-cli'])
    expect(isFeatureTipId(Symbol('orca-cli'))).toBe(false)
    expect(binding).not.toHaveBeenCalled()
    setOrcaDispatchBinding(null)
  })

  it('keeps the core catalog and the rendered catalog identical', () => {
    // The shim resolves the core's ids back to the twin's rows, so a drift
    // between the two catalogs would otherwise be invisible from the app side.
    bindWasm()
    const raw = JSON.parse(
      orcaDispatch(
        'feature-tips',
        'getOrderedUnseenFeatureTips',
        JSON.stringify({ seenTipIds: [], completedTipIds: [] })
      )
    )
    setOrcaDispatchBinding(null)
    expect(raw).toEqual(FEATURE_TIPS)
  })

  it('falls back to the twin selection when the core names an unknown tip', () => {
    // Unreachable while the catalogs agree (pinned above); pinned here so the
    // shim degrades to the twin's own rows rather than dropping a tip silently.
    setOrcaDispatchBinding(() => JSON.stringify([{ id: 'tip-from-the-future' }]))
    expect(
      getOrderedUnseenFeatureTips({ seenTipIds: new Set<FeatureTipId>(['orca-cli']) }).map(
        (tip) => tip.id
      )
    ).toEqual(['cmd-j-palette', 'voice-dictation'])
    setOrcaDispatchBinding(null)
  })
})

// The unbound seam is the mobile client, the preload and a session whose wasm
// FAILED — not a boot blip — so these pin the two write-back paths directly.
describe('what a pre-ready answer would be persisted as', () => {
  it('never hydrates an empty seen list for a real one', () => {
    setOrcaDispatchBinding(null)
    expect(normalizeFeatureTipIds(['orca-cli', 'voice-dictation'])).toEqual([
      'orca-cli',
      'voice-dictation'
    ])
  })

  it('never offers a tip the completion state already retired', () => {
    setOrcaDispatchBinding(null)
    expect(
      getOrderedUnseenFeatureTips({
        seenTipIds: new Set<FeatureTipId>(),
        completedTipIds: getCompletedFeatureTipIds({
          cliInstalled: true,
          voiceDictationEnabled: true
        })
      }).map((tip) => tip.id)
    ).toEqual(['cmd-j-palette'])
  })
})
