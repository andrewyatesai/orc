// Logic moved to the Rust `orca_core::terminal_tab_id` core; this twin keeps only
// the one piece of DATA the validity rule is made of. Consumers reach the core
// through the seam their tree owns:
//   renderer      -> src/renderer/src/lib/git-wasm/terminal-tab-id.ts (wasm)
//   main          -> src/main/rust-terminal-tab-id.ts (napi)
//   src/shared/*  -> src/shared/terminal-tab-id-validity.ts (orca-dispatch seam)
//
// Why the constant stays: each of those shims rebuilds the deleted body from it as
// its not-ready fallback (these predicates gate tab IDENTITY, so pre-ready MUST
// equal ready for every input — see the headers there), and one exported delimiter
// is what stops the three fallbacks from drifting apart. The host-tab half also
// composes WEB_TERMINAL_SURFACE_TAB_PREFIX, ./terminal-surface-id's kept constant.

/** The pane-key separator (`makePaneKey` builds `tabId:leafId`), so a tab id that
 *  contains it cannot be addressed as a pane. */
export const TERMINAL_TAB_ID_PANE_KEY_DELIMITER = ':'
