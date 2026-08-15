// Main-process repo-badge-color normalizers, driven by the Rust
// repo-badge-color core via napi (the shared TS twin is reduced to types/data).
// One source of truth with the parity-proven Rust port.
//
// No pre-ready case here, unlike the renderer shim
// (src/renderer/src/lib/git-wasm/repo-badge-color.ts): `requireRustGitBinding()`
// loads the addon synchronously and throws if it cannot, so these either answer
// or fail loudly — they never return a placeholder a caller could persist.
import { dispatchToRustCore } from './rust-core-dispatch'

// Why: the codec REJECTS an `undefined` property and callers pass unvalidated
// `unknown` (zod input, IPC update patches). The deleted TS answered null/DEFAULT
// for every non-string, which is what the Rust core answers for '', so coerce
// here instead of widening the wire contract.
function colorArg(value: unknown): { value: string } {
  return { value: typeof value === 'string' ? value : '' }
}

export function normalizeRepoBadgeColor(value: unknown): string | null {
  return dispatchToRustCore('repo-badge-color', 'normalizeRepoBadgeColor', colorArg(value)) as
    | string
    | null
}

export function resolveRepoBadgeColor(value: unknown): string {
  return dispatchToRustCore('repo-badge-color', 'resolveRepoBadgeColor', colorArg(value)) as string
}
