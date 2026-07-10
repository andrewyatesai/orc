export const ATERM_RAIN_CELL_WORDS = 4
export const ATERM_RAIN_QUAD_WORDS = 12
export const ATERM_RAIN_MAX_QUADS = 2048

/** Narrow checked surface of the generated aterm-effects-web wasm-bindgen class. */
export type AtermRainOverlayBinding = {
  free(): void
  resize_staging(rows: number, cols: number): void
  cell_words(): number
  cell_flag_default_background(): number
  cell_flag_wide_continuation(): number
  cell_flag_underline(): number
  cell_flag_strikethrough(): number
  cell_flag_overline(): number
  cell_flag_selected(): number
  cell_flag_inline_image(): number
  opaque_scalar(): number
  staging_ptr(): number
  staging_len_words(): number
  set_live_state(
    cursorRow: number,
    cursorCol: number,
    displayOffset: number,
    isAltScreen: boolean
  ): void
  set_hidden_cursor_rows(rows: Uint16Array): void
  sync_snapshot(revision: number, contentSequence: number): number
  advance_effects(deltaMs: number): void
  emit(cellWidth: number, cellHeight: number): bigint | number
  is_active(): boolean
  note_keystroke(): void
  note_bell(): void
  note_alt_scroll(): void
  note_exit_status(failed: boolean): void
  set_enabled(enabled: boolean): void
  set_visibility(state: number): void
  set_reduced_motion(reduced: boolean): void
  set_theme(defaultBackground: number, themeForeground: number): void
  set_rate(
    fps: number,
    density: number,
    speed: number,
    trail: number,
    mutationMs: number,
    idleSeconds: number
  ): void
  set_alpha(alpha: number, headAlpha: number): void
  set_hue(mode: number, custom: number): void
  set_behavior(
    suppressInAltScreen: boolean,
    turnWave: boolean,
    bellAlert: boolean,
    outputMaterial: boolean
  ): void
  set_seed(seedLow: number, seedHigh: number): void
  quad_words(): number
  quads_ptr(): number
  quads_len_words(): number
  atlas_ptr(): number
  atlas_len(): number
  atlas_width(): number
  atlas_height(): number
  atlas_version(): bigint | number
}

export type AtermRainOverlayConstructor = new (
  rows: number,
  cols: number,
  defaultBackground: number,
  themeForeground: number,
  seedLow: number,
  seedHigh: number
) => AtermRainOverlayBinding

/** Inject this after the generated module's default initializer has resolved. */
export type AtermEffectsWebModule = {
  readonly memory: WebAssembly.Memory
  readonly AtermRainOverlay: AtermRainOverlayConstructor
}

export type AtermEffectsWebModuleLoader = () =>
  | AtermEffectsWebModule
  | Promise<AtermEffectsWebModule>
