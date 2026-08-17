// The cut-over id functions, checked in BOTH seam states against the twin.
//
// A fallback-vs-core differential structurally cannot see a divergence that only
// appears once the seam is bound (stable-pane-id shipped 71,771 comparisons and
// still had an Array throwing when bound), so every case below runs unbound —
// the web preload's permanent state — and bound, and both must equal the answer
// the deleted `src/shared/contextual-tours.ts` body gave.
import { afterEach, describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import { CONTEXTUAL_TOUR_IDS } from './contextual-tours'
import { isContextualTourId, normalizeContextualTourIds } from './contextual-tour-id-normalization'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'

// The global setup already ran initSync; rebinding is just the callback.
function bind(): void {
  setOrcaDispatchBinding((module, fn, input) => orcaDispatch(module, fn, input))
}

function inBothSeamStates(assert: () => void): void {
  setOrcaDispatchBinding(null)
  assert()
  bind()
  assert()
}

afterEach(bind)

describe('contextual tour id normalization', () => {
  // Moved verbatim from contextual-tours.test.ts with the implementation.
  it('normalizes persisted ids by removing unknowns and duplicates', () => {
    inBothSeamStates(() => {
      expect(
        normalizeContextualTourIds([
          'tasks',
          'unknown',
          'workspace-agent-sessions',
          'browser',
          'tasks',
          null,
          'workspace-creation'
        ])
      ).toEqual(['tasks', 'workspace-agent-sessions', 'browser', 'workspace-creation'])
    })
  })

  it('accepts every catalog id, including floating-workspace', () => {
    inBothSeamStates(() => {
      for (const id of CONTEXTUAL_TOUR_IDS) {
        expect(isContextualTourId(id)).toBe(true)
      }
      expect(normalizeContextualTourIds([...CONTEXTUAL_TOUR_IDS])).toEqual([...CONTEXTUAL_TOUR_IDS])
    })
  })

  it('rejects unknown ids and non-strings', () => {
    inBothSeamStates(() => {
      for (const value of ['', 'unknown', 'Tasks', ' tasks', null, undefined, 42, true, {}, []]) {
        expect(isContextualTourId(value)).toBe(false)
      }
      // A non-array is not a seen-list; a list of junk normalizes to empty.
      for (const value of ['nope', null, undefined, 0, {}]) {
        expect(normalizeContextualTourIds(value)).toEqual([])
      }
      expect(normalizeContextualTourIds([null, 42, {}, ['tasks']])).toEqual([])
    })
  })

  // These reach the codec's refusals, and both inputs are UNVALIDATED: a
  // persisted `ui` blob off disk, a relay peer's merge payload. The twin looked
  // only for known strings, so its answer is the fallback's answer.
  it('answers the twin for payloads that cannot cross the seam', () => {
    const cyclic: unknown[] = ['tasks']
    cyclic.push(cyclic)
    const sparse = ['tasks']
    sparse[3] = 'browser'

    inBothSeamStates(() => {
      expect(isContextualTourId(Number.NaN)).toBe(false)
      expect(isContextualTourId(-0)).toBe(false)
      expect(isContextualTourId(10n)).toBe(false)
      expect(isContextualTourId(Symbol('tasks'))).toBe(false)
      expect(isContextualTourId(new Date())).toBe(false)
      expect(isContextualTourId('\ud800')).toBe(false)
      expect(normalizeContextualTourIds(sparse)).toEqual(['tasks', 'browser'])
      expect(normalizeContextualTourIds(['tasks', undefined, 'browser'])).toEqual([
        'tasks',
        'browser'
      ])
      expect(normalizeContextualTourIds(['tasks', '\ud800'])).toEqual(['tasks'])
      expect(normalizeContextualTourIds(['tasks', Number.NaN, -0])).toEqual(['tasks'])
      expect(normalizeContextualTourIds(cyclic)).toEqual(['tasks'])
      expect(normalizeContextualTourIds(new Set(['tasks']))).toEqual([])
    })
  })

  it('keeps first-seen order across duplicates', () => {
    inBothSeamStates(() => {
      expect(
        normalizeContextualTourIds([
          'workspace-creation',
          'browser',
          'workspace-creation',
          'floating-workspace',
          'browser'
        ])
      ).toEqual(['workspace-creation', 'browser', 'floating-workspace'])
    })
  })
})
