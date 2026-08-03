//! napi marshalling for `terminal.screen` — the styled visible grid.
//!
//! Its own module because the frame is a nested shape (frame -> rows -> runs,
//! plus cursor and modes) and lib.rs already carries the whole flat
//! `HeadlessTerminal` surface; the method there stays one call into
//! [`to_js_frame`].
//!
//! Marshalling choices worth knowing:
//!
//! * Colours cross as `#rrggbb`. They are already RESOLVED by the engine, so a
//!   string is the whole value — no palette, no default sentinel, nothing for
//!   the JS side to look up.
//! * Attributes cross as the terse code string `orca_terminal` produced
//!   (`SCREEN_ATTR_CODES`); the TS layer expands it into named flags. Sending
//!   arrays of names per run would multiply the payload for a value that is
//!   empty on most runs.
//! * Counts that can legitimately exceed `u32` do not exist here (a grid is
//!   bounded by `u16` dimensions), so plain `u32` is used throughout.

use napi_derive::napi;
use orca_terminal::StyledFrame;

/// One horizontal run of cells sharing a resolved style.
#[napi(object)]
pub struct JsStyleRun {
    /// First column, 0-based from the left edge.
    pub col: u32,
    /// Columns spanned — may exceed the grapheme count of `text`, because a
    /// wide glyph occupies two columns and its continuation column has no text.
    pub cols: u32,
    pub text: String,
    /// Resolved foreground, `#rrggbb`.
    pub fg: String,
    /// Resolved background, `#rrggbb`.
    pub bg: String,
    /// Raw SGR bits as code letters; empty for unstyled text.
    pub attrs: String,
    /// OSC-8 target. Always null in compact detail, which does not probe.
    pub hyperlink: Option<String>,
}

#[napi(object)]
pub struct JsStyledRow {
    /// Index in the visible grid, 0-based from the top.
    pub row: u32,
    pub runs: Vec<JsStyleRun>,
}

#[napi(object)]
pub struct JsScreenCursor {
    pub row: u32,
    pub col: u32,
    /// DECTCEM. A hidden cursor still has a position.
    pub visible: bool,
    /// DECSCUSR shape name, `hollow-block`/`bolt` for the engine-only shapes,
    /// or `unknown` for a shape this build does not name.
    pub style: String,
}

/// The modes that change what a byte written to this pane MEANS.
#[napi(object)]
pub struct JsScreenModes {
    pub alternate_screen: bool,
    pub application_cursor: bool,
    pub bracketed_paste: bool,
    /// `none` | `x10` | `normal` | `button` | `any`.
    pub mouse_tracking: String,
    pub sgr_mouse: bool,
    pub sgr_pixels: bool,
    /// Coordinate encoding by name; the booleans cannot tell X10 from 1005 or 1015.
    pub mouse_encoding: String,
    /// Kitty keyboard-protocol flags; 0 = protocol inactive.
    pub kitty_keyboard_flags: u32,
    /// DECSCNM, already folded into every colour above.
    pub reverse_video: bool,
}

#[napi(object)]
pub struct JsStyledFrame {
    /// Full grid size, independent of the rows this read returned.
    pub rows: u32,
    pub cols: u32,
    /// Grid index of `grid[0]`.
    pub first_row: u32,
    /// Rows were withheld — by a row window or by the run budget. Rows are cut
    /// WHOLE, so no returned row is ever partial.
    pub rows_truncated: bool,
    pub runs_total: u32,
    /// Trailing default-blank tails were dropped from each row.
    pub trailing_blanks_trimmed: bool,
    /// The terminal's live default colours (DECSCNM applied), `#rrggbb`.
    pub default_fg: String,
    pub default_bg: String,
    pub cursor: JsScreenCursor,
    pub modes: JsScreenModes,
    /// Grid content generation, as f64 (it is a u64 counter). Equal across two
    /// reads means the CELLS did not change; it does not cover cursor movement.
    pub content_seq: f64,
    pub grid: Vec<JsStyledRow>,
}

fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

pub fn to_js_frame(frame: StyledFrame) -> JsStyledFrame {
    JsStyledFrame {
        rows: frame.rows as u32,
        cols: frame.cols as u32,
        first_row: frame.first_row as u32,
        rows_truncated: frame.rows_truncated,
        runs_total: frame.runs_total as u32,
        trailing_blanks_trimmed: frame.trailing_blanks_trimmed,
        default_fg: hex(frame.default_fg),
        default_bg: hex(frame.default_bg),
        cursor: JsScreenCursor {
            row: frame.cursor.row as u32,
            col: frame.cursor.col as u32,
            visible: frame.cursor.visible,
            style: frame.cursor.style.to_string(),
        },
        modes: JsScreenModes {
            alternate_screen: frame.modes.alternate_screen,
            application_cursor: frame.modes.application_cursor,
            bracketed_paste: frame.modes.bracketed_paste,
            mouse_tracking: frame.modes.mouse_tracking.to_string(),
            sgr_mouse: frame.modes.sgr_mouse,
            sgr_pixels: frame.modes.sgr_pixels,
            mouse_encoding: frame.modes.mouse_encoding.to_string(),
            kitty_keyboard_flags: u32::from(frame.modes.kitty_keyboard_flags),
            reverse_video: frame.modes.reverse_video,
        },
        content_seq: frame.content_seq as f64,
        grid: frame
            .grid
            .into_iter()
            .map(|row| JsStyledRow {
                row: row.row as u32,
                runs: row
                    .runs
                    .into_iter()
                    .map(|run| JsStyleRun {
                        col: run.col as u32,
                        cols: run.cols as u32,
                        text: run.text,
                        fg: hex(run.fg),
                        bg: hex(run.bg),
                        attrs: run.attrs,
                        hyperlink: run.hyperlink,
                    })
                    .collect(),
            })
            .collect(),
    }
}
