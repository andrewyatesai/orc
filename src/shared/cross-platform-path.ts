// Reduced twin for the `cross_platform_path` cut-over. Everything this module
// used to implement — the comparison key, separator folding, absoluteness,
// resolution, basename and containment — now reaches
// `orca_core::cross_platform_path` through `cross-platform-path-resolution.ts`
// on the orca-dispatch seam. Import from there, not from here.
//
// One predicate stays a real TS implementation, on purpose:
// `renderer/lib/git-wasm/setup-runner-command-platform.ts` rebuilds its own
// pre-ready fallback out of it, and a fallback that itself dispatches is not a
// fallback. `cross-platform-path-resolution.ts` needs it for the same reason, so
// cutting it over would leave both shims with nothing to fall back to. Keeping
// it here also keeps its parity vectors a genuine TS-vs-Rust differential rather
// than a self-comparison.

export function isWindowsAbsolutePathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')
}
