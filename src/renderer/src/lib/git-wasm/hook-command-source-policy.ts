// Renderer hook-command source-policy resolution, driven by the Rust orca-core
// in the orca-git wasm module (the shared TS impl was deleted). Consumers run
// this synchronously in the new-workspace / setup-script / hooks-confirm flows,
// and first paint is gated on wasm-ready, so the only pre-ready run is a wasm
// load FAILURE. The fallback returns the safe `shared-only` default — the same
// value the TS returned for the "no info" case — so a load failure never grants
// local-script execution the user never configured.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type { HookCommandSourcePolicy } from '../../../../shared/hook-command-source-policy'

// Why 'omit': an absent `policy` key IS the "setting not configured" branch the
// Rust side reads as None — see resolveHookCommandSourcePolicy below.
function op(fn: string, input: unknown): unknown | null {
  if (!isGitWasmReady()) {return null}
  return dispatchToWasmCore('hook-command-source-policy', fn, input, {
    undefinedProperties: 'omit'
  })
}

export function resolveHookCommandSourcePolicy(
  policy: unknown,
  { hasLocalScript }: { hasLocalScript: boolean }
): HookCommandSourcePolicy {
  // JSON.stringify drops an `undefined` policy key → Rust `None` (the
  // absent-setting branch); a present-but-invalid string stays a string and
  // never enables local-only.
  const r = op('resolveHookCommandSourcePolicy', { policy, hasLocalScript }) as
    | HookCommandSourcePolicy
    | null
  return r ?? 'shared-only'
}
