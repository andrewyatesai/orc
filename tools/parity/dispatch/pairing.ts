// TS dispatch for the pairing parity module: maps the shared vector function
// names to the real `src/shared/pairing.ts` exports so the harness compares the
// live TS reference against the Rust port.
//
// The twin's schema reads Date.now() internally (see mobile-relay-pairing-offer),
// so these calls run with the global clock pinned to the same instant the Rust
// dispatch passes. Without that, a vector whose payload carries a `relay` object
// would compare two different instants and report a fabricated divergence — or,
// worse, agree by luck.

import {
  decodePairingOffer,
  encodePairingOffer,
  parsePairingCode,
  type PairingOffer
} from '../../../src/shared/pairing'

/** Must equal `VECTOR_CLOCK_MS` in rust/crates/orca-dispatch/src/modules/pairing.rs. */
const VECTOR_CLOCK_MS = 0

function atVectorClock<T>(run: () => T): T {
  const realNow = Date.now
  Date.now = () => VECTOR_CLOCK_MS
  try {
    return run()
  } finally {
    Date.now = realNow
  }
}

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'encodePairingOffer':
      // encodePairingOffer runs the offer through the schema and throws on a bad
      // one; normalize the throw to null the way the decode arms already do.
      return atVectorClock(() => {
        try {
          return encodePairingOffer(input as PairingOffer)
        } catch {
          return null
        }
      })
    case 'decodePairingOffer':
      // decodePairingOffer throws on a bad URL/payload; normalize the throw to
      // null so the Rust `Result::Err` arm has the same JSON image to compare.
      return atVectorClock(() => {
        try {
          return decodePairingOffer(input as string)
        } catch {
          return null
        }
      })
    case 'parsePairingCode':
      return atVectorClock(() => parsePairingCode(input as string))
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
