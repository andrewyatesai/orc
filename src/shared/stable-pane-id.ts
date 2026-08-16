// Why: paneKey crosses renderer reloads, PTY env, hook IPC, and retained UI
// rows, so it must use the durable terminal-layout leaf UUID instead of the
// renderer-local numeric PaneManager id.
//
// CUT OVER to `orca_core::stable_pane_id`. What is left here is the branded
// types and the three data constants the Rust port was written against; every
// caller reaches the logic through `src/shared/stable-pane-identity.ts` on the
// orca-dispatch seam, whose pre-ready fallback rebuilds the deleted bodies out
// of exactly these constants.

/** v1-v5 UUID, LOWERCASE only — the twin's regex carried no `i` flag, and an
 *  uppercase id is therefore not a leaf id on either leg. */
export const STABLE_PANE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** `paneKey.length > 256`: UTF-16 code units, measured BEFORE the trim. */
export const LEGACY_NUMERIC_PANE_KEY_MAX_LENGTH = 256

/** The legacy pane id tail — ASCII digits only, so `١٢` and `１２` are not it. */
export const LEGACY_NUMERIC_PANE_ID_PATTERN = /^\d+$/

declare const stablePaneIdBrand: unique symbol
declare const terminalLeafIdBrand: unique symbol
declare const paneKeyBrand: unique symbol

export type StablePaneId = string & { readonly [stablePaneIdBrand]: true }
export type TerminalLeafId = StablePaneId & { readonly [terminalLeafIdBrand]: true }
export type PaneKey = string & { readonly [paneKeyBrand]: true }
