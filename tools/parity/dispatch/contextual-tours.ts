// TS dispatch for the contextual-tours parity module: maps the shared vector
// function names to the real TS exports so the harness compares the live TS
// reference against the Rust port.
//
// The two id functions were CUT OVER — like the stable-pane-id and wsl-paths
// adapters this drives the SHIM, and config/vitest.parity.config.ts installs no
// setup file, so the seam is unbound here and the shim answers from its `parity`
// fallback: exactly the deleted body, and exactly the code the web preload runs
// forever. `getContextualTour` still reads the TS catalog — the shipped cores'
// step tables are stale, so it is not routed (see the twin's header).

import { getContextualTour, type ContextualTourId } from '../../../src/shared/contextual-tours'
import {
  isContextualTourId,
  normalizeContextualTourIds
} from '../../../src/shared/contextual-tour-id-normalization'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'isContextualTourId':
      return isContextualTourId(input)
    case 'normalizeContextualTourIds':
      return normalizeContextualTourIds(input)
    case 'getContextualTour':
      return getContextualTour(input as ContextualTourId)
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
