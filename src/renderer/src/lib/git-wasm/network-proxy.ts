// Renderer proxy-input normalizers, driven by the Rust orca-net core in the
// orca-git wasm module (the shared TS impl was deleted). The sole consumer runs
// these in onBlur/commit event handlers, and first paint is gated on wasm-ready,
// so the only time these run pre-ready is a wasm load FAILURE. The fallbacks are
// chosen to PRESERVE the user's saved proxy rather than clobber it: an empty
// "validated" value would make the commit handler silently clear the setting.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type { ProxyUrlValidationResult } from '../../../../shared/network-proxy'

// Why 'omit': both NetworkProxySettings fields are optional, and an unset proxy
// key is what the Rust struct reads as None.
function op(fn: string, input: unknown): unknown | null {
  if (!isGitWasmReady()) {return null}
  return dispatchToWasmCore('network-proxy', fn, input, { undefinedProperties: 'omit' })
}

export function normalizeProxyUrl(value: unknown): ProxyUrlValidationResult {
  const r = op('normalizeProxyUrl', value) as ProxyUrlValidationResult | null
  // Pass the draft through as-is on wasm-load failure rather than an empty
  // "validated" value, so the commit handler preserves the user's typed proxy
  // instead of silently clearing the saved one.
  return r ?? { ok: true, value: typeof value === 'string' ? value : '' }
}

export function normalizeProxyBypassRules(value: unknown): string {
  const r = op('normalizeProxyBypassRules', value) as string | null
  // Pass the draft through unnormalized rather than '' so a wasm-load failure
  // can't wipe the user's configured bypass rules.
  return r ?? (typeof value === 'string' ? value : '')
}
