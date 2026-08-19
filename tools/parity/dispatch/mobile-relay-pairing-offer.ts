// TS dispatch for the mobile-relay-pairing-offer parity module: drives the LIVE
// `src/shared/mobile-relay-pairing-offer.ts` schema — the validation that
// `src/shared/pairing.ts` re-exports and owns none of.
//
// THE CLOCK. The schema's invite window is evaluated against `now()`, so it is
// not a pure function of its input and cannot be a parity vector without one.
// `createPairingOfferSchema(now)` is the twin's OWN injection point, so
// `validatePairingOffer` passes the vector's `nowMs` straight into it — no
// patching, no double. The three deep-link arms used to pin the global clock,
// because the twin's exports were bound to the default `() => Date.now()`; they
// now go through `src/shared/pairing-deep-link.ts`, which takes `nowMs` as an
// argument on every entry point, so the vector's instant is simply passed. Both
// routes compare the two halves AT A NAMED INSTANT; what neither can promise is
// that production's two callers observe the same instant — that is why the Rust
// side takes `now_ms` as an argument instead of reading a clock of its own.
//
// The three deep-link arms drive the SHIM with the seam unbound (this config
// installs no setup file), so they compare the pre-ready fallback against Rust.
// The fallback is where this module's own residuals are mirrored, which is why
// the two `xn--` vectors below still carry `allowDivergence`: the case that
// diverges is `validatePairingOffer`, which is the raw schema and does not go
// through the shim.

import {
  decodePairingOffer,
  encodePairingOffer,
  parsePairingCode,
  type PairingOffer
} from '../../../src/shared/pairing-deep-link'
import { createPairingOfferSchema } from '../../../src/shared/mobile-relay-pairing-offer'

type ClockInput = {
  nowMs?: number
  payload?: unknown
  offer?: unknown
  url?: string
  input?: string
}

function requireClock(args: ClockInput): number {
  // Why: an omitted nowMs would silently fall back to the wall clock on the TS
  // side while Rust read NaN — a vector that cannot be compared must not run.
  if (typeof args.nowMs !== 'number') {
    throw new Error('mobile-relay-pairing-offer vectors must pass an explicit `nowMs`')
  }
  return args.nowMs
}

function orNull<T>(run: () => T): T | null {
  try {
    return run()
  } catch {
    return null
  }
}

export function dispatch(fn: string, input: unknown): unknown {
  const args = (input ?? {}) as ClockInput
  const nowMs = requireClock(args)
  switch (fn) {
    case 'validatePairingOffer': {
      const result = createPairingOfferSchema(() => nowMs).safeParse(args.payload)
      return result.success ? result.data : null
    }
    case 'encodePairingOffer':
      return orNull(() => encodePairingOffer(args.offer as PairingOffer, nowMs))
    case 'decodePairingOffer':
      return orNull(() => decodePairingOffer(args.url as string, nowMs))
    case 'parsePairingCode':
      return parsePairingCode(args.input as string, nowMs)
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
