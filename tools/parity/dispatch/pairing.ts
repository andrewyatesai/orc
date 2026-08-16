// TS dispatch for the pairing parity module. The shared TS impl was DELETED
// (`src/shared/pairing.ts` keeps the types, the re-exported schema and the four
// route/shape constants) — every surface now reaches `orca_relay::pairing`
// through `src/shared/pairing-deep-link.ts` on the orca-dispatch seam.
//
// Like the stable-pane-id and worktree-id adapters, this drives the SHIM rather
// than the wasm oracle, so the harness keeps a real TS-vs-Rust differential
// instead of degenerating to wasm-vs-binary: config/vitest.parity.config.ts
// installs no setup file, so the seam is unbound here and the shim answers from
// its `parity` fallback — which is exactly the deleted body, and exactly the
// code the renderer and the relay run before their binding lands.
//
// THE CLOCK IS PASSED, NOT PINNED. The old adapter monkey-patched the global
// `Date.now` for the duration of each call because the twin's schema read it
// internally; the shim takes `nowMs` as an argument, so the vector's instant
// goes straight in. It must equal `VECTOR_CLOCK_MS` in
// rust/crates/orca-dispatch/src/modules/pairing.rs — that arm hardcodes the
// instant, which is also why the production shim routes at the sibling
// `mobile-relay-pairing-offer` arm instead of this one.

import {
  decodePairingOffer,
  encodePairingOffer,
  parsePairingCode,
  type PairingOffer
} from '../../../src/shared/pairing-deep-link'

/** Must equal `VECTOR_CLOCK_MS` in rust/crates/orca-dispatch/src/modules/pairing.rs. */
const VECTOR_CLOCK_MS = 0

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'encodePairingOffer':
      // encodePairingOffer runs the offer through the schema and throws on a bad
      // one; normalize the throw to null the way the decode arms already do.
      try {
        return encodePairingOffer(input as PairingOffer, VECTOR_CLOCK_MS)
      } catch {
        return null
      }
    case 'decodePairingOffer':
      // decodePairingOffer throws on a bad URL/payload; normalize the throw to
      // null so the Rust `Result::Err` arm has the same JSON image to compare.
      try {
        return decodePairingOffer(input as string, VECTOR_CLOCK_MS)
      } catch {
        return null
      }
    case 'parsePairingCode':
      return parsePairingCode(input as string, VECTOR_CLOCK_MS)
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
