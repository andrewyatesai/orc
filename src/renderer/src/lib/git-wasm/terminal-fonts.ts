// Renderer terminal font-weight normalizer + bold-weight resolver, driven by the
// Rust `orca_core::terminal_fonts` port in the orca-git wasm (the shared TS
// bodies were deleted; only the numeric range consts + types still live in TS).
// Every call goes through the single `op` JSON boundary. Pre-ready the op returns
// null, so weights degrade to the Orca defaults (never NaN/undefined) during the
// ~tens-of-ms wasm boot window — the settings sliders and terminal theming that
// read these synchronously in render stay valid.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import { DEFAULT_TERMINAL_FONT_WEIGHT } from '../../../../shared/terminal-fonts'

function op(fn: string, fontWeight: number | null | undefined): unknown | null {
  if (!isGitWasmReady()) {
    return null
  }
  // Single bare-number arg (Rust reads input.as_f64()); only undefined means
  // "unset", so keep the `?? null` — a NaN weight is now rejected rather than
  // silently collapsing into that same unset case.
  return dispatchToWasmCore('terminal-fonts', fn, fontWeight ?? null, { root: 'fontWeight' })
}

export function normalizeTerminalFontWeight(fontWeight: number | null | undefined): number {
  const r = op('normalizeTerminalFontWeight', fontWeight) as number | null
  return r ?? DEFAULT_TERMINAL_FONT_WEIGHT
}

export function resolveTerminalFontWeights(fontWeight: number | null | undefined): {
  fontWeight: number
  fontWeightBold: number
} {
  const r = op('resolveTerminalFontWeights', fontWeight) as {
    fontWeight: number
    fontWeightBold: number
  } | null
  // Pre-ready: what the default weight 500 resolves to (base 500, bold floor 700).
  return r ?? { fontWeight: DEFAULT_TERMINAL_FONT_WEIGHT, fontWeightBold: 700 }
}
