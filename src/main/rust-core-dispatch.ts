// The main process's single way into the Rust core: napi `orcaDispatch` with the
// shared dispatch codec on BOTH ends. Every `src/main/rust-*.ts` shim routes
// through here instead of hand-rolling `JSON.parse(binding.orcaDispatch(m, f,
// JSON.stringify(input)))`, so the encode hazards (lone surrogates, NaN/±Infinity,
// -0, dropped `undefined` keys, Date/Map/Set, sparse arrays) are rejected AT THE
// CALL SITE naming the field, and a Rust failure envelope throws instead of being
// cast to a result. The contract lives in src/shared/dispatch-payload-codec.ts
// (its Rust twin is rust/crates/orca-dispatch/src/json_entry.rs).
import { requireRustGitBinding } from './daemon/rust-git-addon'
import {
  decodeDispatchResult,
  encodeDispatchPayload,
  encodeNumericDispatchPayload,
  type DispatchEncodeOptions
} from '../shared/dispatch-payload-codec'

/**
 * Dispatch `input` to `module.fn` in the Rust core and return the decoded result.
 *
 * Pass `{undefinedProperties: 'omit'}` when the module's input struct uses serde
 * `Option<T>` and the shim relies on an absent key meaning `None` — the codec
 * rejects an explicitly-`undefined` property otherwise, because `{a: undefined}`
 * and `{}` must not silently arrive identical.
 */
export function dispatchToRustCore(
  module: string,
  fn: string,
  input: unknown,
  options?: DispatchEncodeOptions
): unknown {
  const call = { module, fn }
  return decodeDispatchResult(
    requireRustGitBinding().orcaDispatch(module, fn, encodeDispatchPayload(input, options)),
    call
  )
}

/** The codec's documented all-numeric fast path, for a payload that is a number
 *  or a flat record of them — no recursive walk, same rejections. */
export function dispatchNumericToRustCore(
  module: string,
  fn: string,
  payload: number | Readonly<Record<string, number>>
): unknown {
  const call = { module, fn }
  return decodeDispatchResult(
    requireRustGitBinding().orcaDispatch(module, fn, encodeNumericDispatchPayload(payload)),
    call
  )
}
