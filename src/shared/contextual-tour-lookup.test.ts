// The cut-over catalog lookup, checked in BOTH seam states against the TS
// catalog this file's twin still authors.
//
// What has to agree here is a whole step table, not a predicate, and it did not
// agree before this cutover: at b06d6c6d2d the Rust catalog carried the board's
// removed tune-density step and was missing the browser's stay-logged-in step.
// So every tour is compared field-for-field, not a sample — sampling three of
// seven is exactly how that drift survived.
import { afterEach, describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import { CONTEXTUAL_TOURS, CONTEXTUAL_TOUR_IDS } from './contextual-tours'
import { getContextualTour } from './contextual-tour-lookup'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'

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

describe('contextual tour lookup', () => {
  it('has seven distinct tours, so the per-tour cases below compare something', () => {
    expect(CONTEXTUAL_TOUR_IDS).toHaveLength(7)
    bind()
    const answers = CONTEXTUAL_TOUR_IDS.map((id) => JSON.stringify(getContextualTour(id)))
    expect(new Set(answers).size).toBe(7)
  })

  for (const id of CONTEXTUAL_TOUR_IDS) {
    it(`returns the authored ${id} tour in both seam states`, () => {
      const authored = CONTEXTUAL_TOURS.find((tour) => tour.id === id)
      inBothSeamStates(() => {
        expect(getContextualTour(id)).toEqual(JSON.parse(JSON.stringify(authored)))
      })
    })
  }

  // The two tours the core had wrong. Named cases so a regression reads as the
  // specific drift rather than as "some tour changed".
  it('gives the board tour two steps, without the removed tune-density step', () => {
    inBothSeamStates(() => {
      const titles = getContextualTour('workspace-board').steps.map((step) => step.title)
      expect(titles).toEqual(['Plan work on the board', 'Move work through lanes'])
    })
  })

  it('gives the browser tour its stay-logged-in step last', () => {
    inBothSeamStates(() => {
      const steps = getContextualTour('browser').steps
      expect(steps.map((step) => step.title)).toEqual([
        'Grab page context for agents',
        'Mark design feedback in place',
        'Stay logged in'
      ])
      expect(steps[2]?.targetSelector).toBe(
        '[data-contextual-tour-target="browser-import-hint"], [data-contextual-tour-target="browser-import-cookies-control"]'
      )
    })
  })
})
