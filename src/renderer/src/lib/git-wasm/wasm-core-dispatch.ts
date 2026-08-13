// The renderer's single way into the Rust core: wasm `orcaDispatch` with the
// shared dispatch codec on BOTH ends. Every shim in this directory routes through
// here instead of hand-rolling `JSON.parse(orcaDispatch(m, f, JSON.stringify(
// input)))`, so the encode hazards (lone surrogates, NaN/±Infinity, -0, dropped
// `undefined` keys, Date/Map/Set, sparse arrays) are rejected AT THE CALL SITE
// naming the field, and a Rust failure envelope throws instead of being cast to a
// result. The contract lives in src/shared/dispatch-payload-codec.ts (its Rust
// twin is rust/crates/orca-dispatch/src/json_entry.rs).
//
// Readiness stays with the caller: every shim already guards on isGitWasmReady()
// and owns its own degraded fallback, so this adds no guard of its own.
import { orcaDispatch } from './orca_git_wasm.js'
import {
  decodeDispatchResult,
  encodeDispatchPayload,
  type DispatchEncodeOptions
} from '../../../../shared/dispatch-payload-codec'

/**
 * Dispatch `input` to `module.fn` in the wasm Rust core and return the decoded
 * result. Only call once `isGitWasmReady()`.
 *
 * Pass `{undefinedProperties: 'omit'}` when the module's input struct uses serde
 * `Option<T>` and the shim relies on an absent key meaning `None` — the codec
 * rejects an explicitly-`undefined` property otherwise, because `{a: undefined}`
 * and `{}` must not silently arrive identical.
 */
export function dispatchToWasmCore(
  module: string,
  fn: string,
  input: unknown,
  options?: DispatchEncodeOptions
): unknown {
  const call = { module, fn }
  return decodeDispatchResult(orcaDispatch(module, fn, encodeDispatchPayload(input, options)), call)
}
