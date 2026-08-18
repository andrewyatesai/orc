// TS dispatch for the mobile-relay-pairing-offer parity module: drives the LIVE
// `src/shared/mobile-relay-pairing-offer.ts` schema — the validation that
// `src/shared/pairing.ts` re-exports and owns none of.
//
// THE CLOCK. The schema's invite window is evaluated against `now()`, so it is
// not a pure function of its input and cannot be a parity vector without one.
// `createPairingOfferSchema(now)` is the twin's OWN injection point, so
// `validatePairingOffer` passes the vector's `nowMs` straight into it — no
// patching, no double. The three deep-link arms go through `pairing.ts`, whose
// exports are bound to the default `() => Date.now()`; for those the global clock
// is pinned for the duration of the call, which is the only injection point the
// twin exposes there. Both routes compare the two halves AT A NAMED INSTANT; what
// neither can promise is that production's two callers observe the same instant —
// that is why the Rust side takes `now_ms` as an argument instead of reading a
// clock of its own.

import type { PairingOffer } from '../../../src/shared/pairing'
import {
  decodePairingOffer,
  encodePairingOffer,
  parsePairingCode
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

function atClock<T>(nowMs: number, run: () => T): T {
  const realNow = Date.now
  Date.now = () => nowMs
  try {
    return run()
  } finally {
    Date.now = realNow
  }
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
      return atClock(nowMs, () => orNull(() => encodePairingOffer(args.offer as PairingOffer)))
    case 'decodePairingOffer':
      return atClock(nowMs, () => orNull(() => decodePairingOffer(args.url as string)))
    case 'parsePairingCode':
      return atClock(nowMs, () => parsePairingCode(args.input as string))
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
