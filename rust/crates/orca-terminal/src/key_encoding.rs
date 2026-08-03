//! Engine-encoded keystrokes — the input half of `terminal.key`
//! (docs/reference/alab-agent-visibility.md §5.3(b1), §8 item 5).
//!
//! Why this lives in the engine and not in TypeScript: what a key MEANS on the
//! wire is a function of the pane's LIVE modes, and only the engine knows them.
//! DECCKM turns `ESC [ A` into `ESC O A`; a negotiated Kitty flag re-encodes
//! every key into CSI-u; xterm `modifyOtherKeys` re-encodes the modified ones;
//! DECBKM swaps Backspace between DEL and BS; 1035/1036/1039 change what Alt and
//! Meta prefix. A hand-rolled TS table would be a second, drifting opinion about
//! the terminal that is sitting right here able to answer.
//!
//! So this is a thin bridge, deliberately: [`aterm_types::keyboard`] owns the
//! encoding (the same code path the GUI's real keyboard takes), and this maps
//! Orca's request onto it against `Terminal::keyboard_mode()`.
//!
//! Two honesty properties the caller depends on:
//!
//! * **A name the engine does not know is refused, not approximated.** The
//!   `recognized` flag is separate from the byte count, because "there is no
//!   such key" and "this key encodes to nothing in these modes" are different
//!   facts and a caller must be able to say which one it hit. A wrong escape
//!   sequence in a TUI is worse than no keystroke at all.
//! * **A press is a press AND a release.** Under the Kitty protocol's
//!   `REPORT_EVENT_TYPES` an application is told about both, and a driver that
//!   sends only the press leaves the app believing the key is still held. With
//!   no Kitty flags negotiated the release encodes to nothing, so the legacy
//!   wire is byte-identical to a bare press.

use aterm_types::keyboard::{
    encode_key_with_layout, map_dom_key, KeyEventType, KeyboardMode, Modifiers,
};

use crate::headless::HeadlessTerminal;

/// The four chord modifiers a driver may ask for. `CAPS_LOCK`/`NUM_LOCK`/`HYPER`
/// are lock and platform state, not something a caller "presses", so they are
/// masked off rather than trusted from the wire.
const CHORD_MODIFIERS: Modifiers = Modifiers::SHIFT
    .union(Modifiers::ALT)
    .union(Modifiers::CTRL)
    .union(Modifiers::SUPER);

/// What one keystroke encodes to against a pane's live keyboard modes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyEncoding {
    /// The engine's key table knows this name. False means nothing was encoded
    /// because there is no such key — never because the modes suppressed it.
    pub recognized: bool,
    /// Bytes for the key going down. Empty on a recognized key means the modes
    /// give it no encoding (a modifier-only key, a Kitty-only report the pane
    /// never negotiated).
    pub press: Vec<u8>,
    /// Bytes for the key coming back up — empty unless the pane negotiated the
    /// Kitty `REPORT_EVENT_TYPES` enhancement.
    pub release: Vec<u8>,
    /// The `KeyboardMode` bits the encoding was made against, so a caller can
    /// audit the answer instead of taking it on faith.
    pub mode_bits: u16,
}

impl HeadlessTerminal {
    /// Encode one keystroke against this pane's CURRENT keyboard modes.
    ///
    /// `key` is a DOM `KeyboardEvent.key` value — the vocabulary
    /// `aterm_types::keyboard::map_dom_key` owns, shared with the wasm bindings
    /// so every Orca surface speaks one key table. `modifiers` is the engine's
    /// `Modifiers` bitfield (SHIFT=1, ALT=2, CTRL=4, SUPER=8).
    ///
    /// Never guesses: an unmapped name comes back `recognized: false` with no
    /// bytes, and a mapped key the modes leave unencodable comes back
    /// `recognized: true` with empty `press`.
    pub fn encode_key(&self, key: &str, modifiers: u8) -> KeyEncoding {
        let mode = self.engine().keyboard_mode();
        let Some(key) = map_dom_key(key) else {
            return KeyEncoding { mode_bits: mode.bits(), ..KeyEncoding::default() };
        };
        let mods = Modifiers::from_bits_truncate(modifiers) & CHORD_MODIFIERS;
        KeyEncoding {
            recognized: true,
            press: encode_key_with_layout(&key, mods, mode, KeyEventType::Press, None),
            release: release_bytes(&key, mods, mode),
            mode_bits: mode.bits(),
        }
    }
}

/// The key-up half of the keystroke. Only the Kitty protocol reports it, and
/// asking the encoder outside that mode returns empty — so this is a mode check
/// only to keep the intent readable at the call site.
fn release_bytes(
    key: &aterm_types::keyboard::Key,
    mods: Modifiers,
    mode: KeyboardMode,
) -> Vec<u8> {
    if !mode.contains(KeyboardMode::REPORT_EVENT_TYPES) {
        return Vec::new();
    }
    encode_key_with_layout(key, mods, mode, KeyEventType::Release, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CTRL: u8 = 4;
    const SHIFT: u8 = 1;

    #[test]
    fn a_control_chord_encodes_to_its_control_character() {
        let term = HeadlessTerminal::new(4, 40);
        let encoded = term.encode_key("r", CTRL);
        assert!(encoded.recognized);
        assert_eq!(encoded.press, vec![0x12], "Ctrl+R is DC2");
        assert!(encoded.release.is_empty(), "no kitty flags, no key-up report");
    }

    #[test]
    fn an_arrow_follows_decckm_instead_of_a_fixed_table() {
        let mut term = HeadlessTerminal::new(4, 40);
        assert_eq!(term.encode_key("ArrowUp", 0).press, b"\x1b[A".to_vec());
        term.process_str("\x1b[?1h");
        assert_eq!(
            term.encode_key("ArrowUp", 0).press,
            b"\x1bOA".to_vec(),
            "application-cursor mode moves the arrow onto SS3"
        );
    }

    #[test]
    fn a_negotiated_kitty_pane_re_encodes_the_same_chord() {
        let mut term = HeadlessTerminal::new(4, 40);
        // Push disambiguate + report-event-types, the flags an agent TUI asks for.
        term.process_str("\x1b[>3u");
        let encoded = term.encode_key("r", CTRL);
        assert_eq!(encoded.press, b"\x1b[114;5u".to_vec(), "CSI-u, not the C0 byte");
        assert_eq!(
            encoded.release,
            b"\x1b[114;5:3u".to_vec(),
            "report-event-types means the key must also come back up"
        );
        assert_ne!(encoded.mode_bits, 0, "the audit trail names the negotiated mode");
    }

    #[test]
    fn an_unknown_name_is_refused_rather_than_approximated() {
        let term = HeadlessTerminal::new(4, 40);
        let encoded = term.encode_key("AnyBananaKey", 0);
        assert!(!encoded.recognized);
        assert!(encoded.press.is_empty());
    }

    #[test]
    fn a_modifier_only_key_is_recognized_but_encodes_to_nothing() {
        let term = HeadlessTerminal::new(4, 40);
        // The engine names "Control" but gives it no legacy encoding — the exact
        // case `recognized` exists to separate from "no such key". Both refuse;
        // only one of them means the caller misspelled something.
        let encoded = term.encode_key("Control", 0);
        assert!(encoded.recognized);
        assert!(encoded.press.is_empty());

        // Shift+Tab, by contrast, is recognized AND encodable.
        let back_tab = term.encode_key("Tab", SHIFT);
        assert!(back_tab.recognized);
        assert_eq!(back_tab.press, b"\x1b[Z".to_vec());
    }

    #[test]
    fn lock_modifiers_from_the_wire_are_masked_off() {
        let term = HeadlessTerminal::new(4, 40);
        // 0b0100_0000 is CAPS_LOCK: a lock, not a chord. It must not reach the
        // encoder and turn a plain Enter into a modified CSI-u report.
        assert_eq!(term.encode_key("Enter", 0b0100_0000).press, b"\r".to_vec());
    }
}
