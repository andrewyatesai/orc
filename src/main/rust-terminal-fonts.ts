// Main-process terminal font-weight resolver, driven by the Rust
// `orca_core::terminal_fonts` port via napi (the shared TS impl was deleted).
// One source of truth with the parity-proven Rust port. The vector input is a
// bare number, so we stringify the weight directly (matching the Rust dispatch's
// `input.as_f64()`).
import { dispatchToRustCore } from './rust-core-dispatch'

export function resolveTerminalFontWeights(fontWeight: number | null | undefined): {
  fontWeight: number
  fontWeightBold: number
} {
  // Why `?? null`, not the codec's undefined→null: only undefined means "unset"
  // here; a NaN weight is now rejected rather than collapsing to the unset case.
  return dispatchToRustCore('terminal-fonts', 'resolveTerminalFontWeights', fontWeight ?? null, {
    root: 'fontWeight'
  }) as { fontWeight: number; fontWeightBold: number }
}
