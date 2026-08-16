// The feature-interactions twin's normalizer/predicate tests, moved with the
// implementation onto the seam shim. Every case runs TWICE — with the dispatch
// seam unbound (the renderer before wasm init, the preload, the Playwright
// specs) and bound to the wasm core (main/cli via napi, the relay via initSync)
// — because these answers are PERSISTED as the interaction state itself: the two
// `mergeFeatureInteractionState` sites normalize both sides and write the merged
// map straight back, so a pre-ready `{}` would erase the user's whole recorded
// history.
import { afterEach, describe, expect, it } from 'vitest'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import {
  hasFeatureInteraction,
  isFeatureInteractionId,
  normalizeFeatureInteractions,
  normalizeFeatureInteractionTelemetryBuckets
} from './feature-interaction-state'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

/** Run `call` unbound and bound; assert both equal `expected`. */
function bothStates<T>(call: () => T, expected: T): void {
  setOrcaDispatchBinding(null)
  expect(call()).toEqual(expected)
  bindWasm()
  expect(call()).toEqual(expected)
}

afterEach(() => setOrcaDispatchBinding(null))

describe('feature interaction state', () => {
  it('normalizes persisted records by removing unknown ids and malformed values', () => {
    bothStates(
      () =>
        normalizeFeatureInteractions({
          tasks: { firstInteractedAt: 100 },
          browser: { firstInteractedAt: Number.NaN },
          automations: { firstInteractedAt: 200, interactionCount: 3 },
          'browser-grab': { firstInteractedAt: 250, interactionCount: 0 },
          unknown: { firstInteractedAt: 200 },
          'voice-dictation': { firstInteractedAt: 300 }
        }),
      {
        tasks: { firstInteractedAt: 100, interactionCount: 1 },
        automations: { firstInteractedAt: 200, interactionCount: 3 },
        'browser-grab': { firstInteractedAt: 250, interactionCount: 1 },
        'voice-dictation': { firstInteractedAt: 300, interactionCount: 1 }
      }
    )
  })

  it('treats only valid known records as interacted', () => {
    bothStates(
      () =>
        hasFeatureInteraction({ tasks: { firstInteractedAt: 100, interactionCount: 1 } }, 'tasks'),
      true
    )
    bothStates(
      () =>
        hasFeatureInteraction(
          { tasks: { firstInteractedAt: 100, interactionCount: 1 } },
          'browser'
        ),
      false
    )
    bothStates(
      () =>
        hasFeatureInteraction(
          { tasks: { firstInteractedAt: Number.POSITIVE_INFINITY, interactionCount: 1 } },
          'tasks'
        ),
      false
    )
  })

  it('normalizes persisted telemetry bucket markers by removing unknown ids and buckets', () => {
    bothStates(
      () =>
        normalizeFeatureInteractionTelemetryBuckets({
          tasks: 'count_1',
          browser: 'count_1000_plus',
          automations: 'count_4',
          unknown: 'count_1',
          'voice-dictation': null
        }),
      { tasks: 'count_1', browser: 'count_1000_plus' }
    )
  })

  it('recognises catalog ids and rejects everything else', () => {
    bothStates(() => isFeatureInteractionId('tasks'), true)
    bothStates(() => isFeatureInteractionId('nope'), false)
    bothStates(() => isFeatureInteractionId(''), false)
    bothStates(() => isFeatureInteractionId(null), false)
    bothStates(() => isFeatureInteractionId(7), false)
    // Why: `Array.prototype.includes` is not a catalog lookup — an inherited
    // Object.prototype member must not read as an id.
    bothStates(() => isFeatureInteractionId('toString'), false)
  })

  it('keeps a non-object blob, an array and a missing blob as an empty state', () => {
    for (const blob of [null, undefined, 'nope', 7, true, [1, 2, 3]]) {
      bothStates(() => normalizeFeatureInteractions(blob), {})
      bothStates(() => normalizeFeatureInteractionTelemetryBuckets(blob), {})
    }
  })

  // Why pinned: the returned map is spread into the persisted record, so its key
  // order is what lands on disk; BTreeMap-over-the-enum on the Rust side has to
  // stay the catalog order the twin's id loop produced.
  it('emits records in catalog order whatever order the blob carried them in', () => {
    const blob = {
      'voice-dictation': { firstInteractedAt: 3, interactionCount: 1 },
      tasks: { firstInteractedAt: 1, interactionCount: 1 },
      browser: { firstInteractedAt: 2, interactionCount: 1 }
    }
    const expected = ['browser', 'tasks', 'voice-dictation']
    bothStates(() => Object.keys(normalizeFeatureInteractions(blob)), expected)
  })

  // Why pinned: `id` is typed but arrives out of persisted JSON and off the relay
  // wire, and the Rust arm answers an off-catalog id with `__parity_error__`,
  // which decodeDispatchResult THROWS. The twin returned false, so the shim must
  // not dispatch those at all.
  it('answers an off-catalog id false instead of throwing the core error', () => {
    const state = { tasks: { firstInteractedAt: 100, interactionCount: 1 } }
    for (const id of ['unknown', 'toString', '__proto__', 'constructor', '']) {
      bothStates(() => hasFeatureInteraction(state, id as 'tasks'), false)
    }
    bindWasm()
    expect(() =>
      JSON.parse(
        orcaDispatch('feature-interactions', 'hasFeatureInteraction', '{"state":{},"id":"unknown"}')
      )
    ).not.toThrow()
    expect(
      JSON.parse(
        orcaDispatch('feature-interactions', 'hasFeatureInteraction', '{"state":{},"id":"unknown"}')
      )
    ).toHaveProperty('__parity_error__')
  })

  // Why pinned: these are exactly the values dispatch-payload-codec refuses, and
  // they are reachable — a hand-edited settings file, a relay JSON.parse. The
  // twin answered them without crossing, so the fallback has to as well.
  it('answers codec-refused payloads locally rather than propagating the refusal', () => {
    bothStates(() => normalizeFeatureInteractions({ tasks: undefined }), {})
    bothStates(() => normalizeFeatureInteractions({ tasks: { firstInteractedAt: Number.NaN } }), {})
    bothStates(() => normalizeFeatureInteractions({ tasks: { firstInteractedAt: -0 } }), {
      tasks: { firstInteractedAt: -0, interactionCount: 1 }
    })
    bothStates(() => normalizeFeatureInteractionTelemetryBuckets({ tasks: '\ud800' }), {})
    bothStates(() => isFeatureInteractionId('\ud800'), false)
    bothStates(
      () =>
        hasFeatureInteraction({ tasks: { firstInteractedAt: -0, interactionCount: 1 } }, 'tasks'),
      true
    )
  })

  // Why pinned: a DispatchCoreError is a broken core, not a payload the twin
  // could answer — it must reach the caller, never be folded into a fallback.
  it('propagates a core failure instead of silently answering locally', () => {
    setOrcaDispatchBinding(() => '{"__dispatch_error__":"unknown module"}')
    expect(() => normalizeFeatureInteractions({ tasks: { firstInteractedAt: 1 } })).toThrow(
      /failed in the Rust core/
    )
  })
})
