// Main-process hook-command source-policy resolution, driven by the Rust
// orca-core via napi (the shared TS impl was deleted). One source of truth with
// the parity-proven Rust port.
import { dispatchToRustCore } from './rust-core-dispatch'
import type { HookCommandSourcePolicy } from '../shared/hook-command-source-policy'

// Why 'omit': an absent `policy` key IS the "setting not configured" branch the
// Rust side reads as None — see resolveHookCommandSourcePolicy below.
function dispatch(fn: string, input: unknown): unknown {
  return dispatchToRustCore('hook-command-source-policy', fn, input, {
    undefinedProperties: 'omit'
  })
}

export function resolveHookCommandSourcePolicy(
  policy: unknown,
  { hasLocalScript }: { hasLocalScript: boolean }
): HookCommandSourcePolicy {
  // JSON.stringify drops an `undefined` policy key, so absent/undefined decodes
  // to Rust `None` (the absent-setting branch that can default to local-only); a
  // present-but-invalid string stays a string and never enables local-only.
  return dispatch('resolveHookCommandSourcePolicy', {
    policy,
    hasLocalScript
  }) as HookCommandSourcePolicy
}
