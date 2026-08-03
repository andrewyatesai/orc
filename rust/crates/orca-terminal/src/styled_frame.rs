//! The styled visible grid — the engine side of `terminal.screen`
//! (docs/reference/alab-agent-visibility.md §2, §8 item 2).
//!
//! Every other read Orca serves is text. `terminal.read` hands back a
//! normalized transcript with all SGR stripped, so a driver can see WHAT a pane
//! says and never which line is selected, highlighted, focused, or under the
//! cursor. Keystroke-driven interaction is guesswork without that: you cannot
//! press the right arrow key if you cannot see which item is already picked.
//!
//! Nothing new was needed in the engine. `aterm-gui`'s own `screen` verb is a
//! JSON wrapper over `render_row_at_screen` + `cell_grapheme` + `hyperlink_at`,
//! all of which `aterm-core` — which Orca already links — answers here.
//!
//! Three shape decisions, each load-bearing:
//!
//! * **Colours are RESOLVED, not raw SGR.** `render_row_at_screen` runs the
//!   engine's own colour resolution: palette lookup, RGB overflow, bold-to-
//!   bright, dim, inverse, hidden, and screen-wide DECSCNM. What comes back is
//!   the pixel a human would see. A raw `Indexed(4)` would force the caller to
//!   own a palette and to re-derive inverse itself — and would silently answer
//!   the wrong question for the one case that matters most, an inverse-video
//!   highlight bar.
//! * **Cells are coalesced into RUNS.** A styled grid is far larger than text;
//!   per-cell records for an 80x24 pane are ~2000 objects for content that is
//!   almost always a handful of style transitions per row. Adjacent cells that
//!   agree on colour, attributes and hyperlink fold into one run carrying its
//!   column, its column WIDTH, and its text.
//! * **The raw attribute bits ride ALONGSIDE the resolved colour.** `inverse`,
//!   `dim`, `blink` and `conceal` are already folded into the fg/bg a viewer
//!   sees, but a driver frequently wants the cause, not just the effect ("this
//!   row is the selection because it is inverse", not "this row happens to be
//!   dark-on-light"). Both are reported.

use aterm_core::terminal::{RenderCell, UnderlineStyle};
use aterm_types::CursorStyle;

use crate::headless::HeadlessTerminal;

/// How much of each row to serve.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ScreenDetail {
    /// Trailing run of default-styled blanks dropped per row, hyperlinks not
    /// probed. The common read: a caller wants to see the screen, not to
    /// reconstruct a byte-exact `rows x cols` matrix.
    #[default]
    Compact,
    /// Every row padded to the full grid width with the terminal's live
    /// implicit blank, and OSC-8 hyperlink targets attached — the lossless form,
    /// matching what `aterm-gui`'s `screen` verb guarantees.
    Full,
}

/// Attribute code letters, one per raw SGR bit. Deliberately terse: this string
/// is an internal marshalling format between this crate and the napi caller,
/// which expands it into self-describing names before it reaches a driver. The
/// first nine letters match this crate's existing `cell_attr_fingerprint`
/// vocabulary so one legend covers both.
///
/// `b` bold, `d` dim, `i` italic, `k` blink, `v` inverse, `c` conceal,
/// `s` strike, `o` overline, then the underline family — `u` single,
/// `U` double, `w` curly, `t` dotted, `a` dashed.
pub const SCREEN_ATTR_CODES: &str = "bdikvcsouUwta";

/// One horizontal run of cells sharing a resolved style.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StyleRun {
    /// First column of the run, 0-based from the left edge of the grid.
    pub col: usize,
    /// Columns the run spans. May exceed `text`'s grapheme count: a wide (CJK
    /// or emoji) glyph occupies two columns and contributes one grapheme, and
    /// its continuation column contributes none.
    pub cols: usize,
    /// The run's graphemes, in order — clusters, not chars, so a combining mark
    /// or a ZWJ emoji sequence stays one unit.
    pub text: String,
    /// Fully resolved foreground, as rendered.
    pub fg: [u8; 3],
    /// Fully resolved background, as rendered.
    pub bg: [u8; 3],
    /// Raw SGR bits as [`SCREEN_ATTR_CODES`] letters; empty for unstyled text.
    pub attrs: String,
    /// OSC-8 target. Always `None` under [`ScreenDetail::Compact`], which does
    /// not probe — absent there means "not asked", not "no link".
    pub hyperlink: Option<String>,
}

/// One visible row as style runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StyledRow {
    /// Row index in the visible grid, 0-based from the top.
    pub row: usize,
    pub runs: Vec<StyleRun>,
}

/// Where the cursor is and what it looks like — the single most important thing
/// a keystroke-driving caller needs and the transcript verbs cannot say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScreenCursor {
    pub row: usize,
    pub col: usize,
    /// DECTCEM. A hidden cursor still has a position; a full-screen TUI hides it
    /// while repainting, so `visible: false` is not "no cursor".
    pub visible: bool,
    /// DECSCUSR shape name, or an engine-only shape (`hollow-block`, `bolt`).
    pub style: &'static str,
}

/// The modes that change what a byte written to this pane MEANS. A driver that
/// sends input without reading these is guessing: an arrow key is `ESC [ A` or
/// `ESC O A` depending on DECCKM alone, and pasted text needs bracketing markers
/// exactly when the app asked for them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScreenModes {
    pub alternate_screen: bool,
    /// DECCKM — arrow/Home/End keys switch to the `SS3` form.
    pub application_cursor: bool,
    /// DECSET 2004 — pasted text must be wrapped in `ESC [ 200~` / `ESC [ 201~`.
    pub bracketed_paste: bool,
    /// `none` | `x10` | `normal` | `button` | `any`.
    pub mouse_tracking: &'static str,
    pub sgr_mouse: bool,
    pub sgr_pixels: bool,
    /// The coordinate encoding by name — the booleans above cannot distinguish
    /// X10 from UTF-8 (1005) or URXVT (1015), and a click encoded for the wrong
    /// one lands on a different cell.
    pub mouse_encoding: &'static str,
    /// Kitty keyboard-protocol flags (0 = protocol inactive). Non-zero changes
    /// the encoding of every key, not just the exotic ones.
    pub kitty_keyboard_flags: u8,
    /// DECSCNM. Already folded into every resolved colour here; reported so a
    /// caller comparing against a stored palette knows why everything inverted.
    pub reverse_video: bool,
}

/// A read of the visible grid: the styled rows plus everything about the frame
/// that a caller needs in order to act on them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StyledFrame {
    /// Full grid height, independent of how many rows this read returned.
    pub rows: usize,
    pub cols: usize,
    /// Row index of `grid[0]`, so a windowed read stays addressable.
    pub first_row: usize,
    /// Rows the run budget refused to serve. Rows are cut WHOLE — a partial row
    /// would be a lie about that row's content.
    pub rows_truncated: bool,
    /// Runs emitted across every returned row.
    pub runs_total: usize,
    /// Trailing default-blank tails were dropped (always true under
    /// [`ScreenDetail::Compact`]). A caller reconstructing a matrix must pad.
    pub trailing_blanks_trimmed: bool,
    /// The terminal's live default colours, with DECSCNM applied — the value a
    /// cell's resolved colour equals when nothing set one.
    pub default_fg: [u8; 3],
    pub default_bg: [u8; 3],
    pub cursor: ScreenCursor,
    pub modes: ScreenModes,
    /// Grid content generation. Unchanged between two reads means the CELLS did
    /// not change; it does NOT cover cursor movement or a DECSCNM flip, both of
    /// which are reported separately above.
    pub content_seq: u64,
    pub grid: Vec<StyledRow>,
}

/// Row window and payload budget for one read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StyledFrameOptions {
    pub detail: ScreenDetail,
    /// First visible row to serve. Past the bottom yields zero rows, not an error.
    pub from_row: usize,
    /// Rows to serve; 0 = every row from `from_row` down.
    pub row_count: usize,
    /// Ceiling on runs across the whole read; 0 = unbounded. The first requested
    /// row is always served whole, so a pathologically styled row yields a
    /// truncated answer rather than an empty one.
    pub max_runs: usize,
}

/// One cell's material, gathered before runs are formed.
struct ScannedCell {
    fg: [u8; 3],
    bg: [u8; 3],
    attrs: String,
    hyperlink: Option<String>,
    /// Empty for the continuation column of a wide glyph, which has no glyph of
    /// its own but still occupies a column.
    text: String,
    /// Nothing here but the terminal's implicit blank — a candidate for the
    /// trailing trim.
    blank: bool,
}

impl HeadlessTerminal {
    /// The visible grid with per-cell colour and attributes, plus the cursor and
    /// the input-affecting modes, from one read of a settled engine.
    ///
    /// Scope is the LIVE screen, never the user's scroll view, and never
    /// history: the engine stores scrolled-off rows as text and discards their
    /// colour, so styled history does not exist to be returned. Callers must
    /// declare that rather than let this frame read as the whole session.
    pub fn styled_frame(&self, opts: StyledFrameOptions) -> StyledFrame {
        let (rows, cols) = self.size();
        let blank = self.engine().implicit_blank_render_cell();
        let last_row = match opts.row_count {
            0 => rows,
            n => opts.from_row.saturating_add(n).min(rows),
        };
        let mut grid: Vec<StyledRow> = Vec::new();
        let mut runs_total = 0usize;
        let mut rows_truncated = false;
        for row in opts.from_row..last_row {
            let runs = self.row_runs(row, cols, &blank, opts.detail);
            // The budget cuts whole rows, and never the first one: an empty
            // answer would be indistinguishable from a blank screen.
            if opts.max_runs > 0 && !grid.is_empty() && runs_total + runs.len() > opts.max_runs {
                rows_truncated = true;
                break;
            }
            runs_total += runs.len();
            grid.push(StyledRow { row, runs });
        }
        rows_truncated = rows_truncated || last_row < rows || opts.from_row > 0;
        let cursor = self.engine().cursor();
        StyledFrame {
            rows,
            cols,
            first_row: opts.from_row.min(rows),
            rows_truncated,
            runs_total,
            trailing_blanks_trimmed: matches!(opts.detail, ScreenDetail::Compact),
            default_fg: blank.fg,
            default_bg: blank.bg,
            cursor: ScreenCursor {
                row: cursor.row as usize,
                col: cursor.col as usize,
                visible: self.engine().cursor_visible(),
                style: cursor_style_name(self.engine().cursor_style()),
            },
            modes: ScreenModes {
                alternate_screen: self.is_alternate_screen(),
                application_cursor: self.application_cursor(),
                bracketed_paste: self.bracketed_paste(),
                mouse_tracking: mouse_tracking_name(self),
                sgr_mouse: self.sgr_mouse(),
                sgr_pixels: self.sgr_pixels(),
                mouse_encoding: self.mouse_encoding_name(),
                kitty_keyboard_flags: self.kitty_keyboard_flags(),
                reverse_video: self.engine().reverse_video(),
            },
            content_seq: self.engine().content_seq(),
            grid,
        }
    }

    /// Coalesce one row's cells into style runs.
    fn row_runs(
        &self,
        row: usize,
        cols: usize,
        blank: &RenderCell,
        detail: ScreenDetail,
    ) -> Vec<StyleRun> {
        let rendered = self.engine().render_row_at_screen(row);
        let mut scanned: Vec<ScannedCell> = Vec::with_capacity(cols);
        for col in 0..cols {
            scanned.push(self.scan_cell(row, col, rendered.get(col).copied(), blank, detail));
        }
        if matches!(detail, ScreenDetail::Compact) {
            // Why trim only DEFAULT blanks: a space painted with a background
            // colour is content (a selection bar, a progress track), and cutting
            // it would erase the very highlight this verb exists to show.
            while scanned.last().is_some_and(|cell| cell.blank) {
                scanned.pop();
            }
        }
        let mut runs: Vec<StyleRun> = Vec::new();
        for (col, cell) in scanned.into_iter().enumerate() {
            match runs.last_mut() {
                Some(run)
                    if run.fg == cell.fg
                        && run.bg == cell.bg
                        && run.attrs == cell.attrs
                        && run.hyperlink == cell.hyperlink =>
                {
                    run.cols += 1;
                    run.text.push_str(&cell.text);
                }
                _ => runs.push(StyleRun {
                    col,
                    cols: 1,
                    text: cell.text,
                    fg: cell.fg,
                    bg: cell.bg,
                    attrs: cell.attrs,
                    hyperlink: cell.hyperlink,
                }),
            }
        }
        runs
    }

    /// Gather one cell: resolved colour + decorations from the live render row,
    /// the raw SGR bits the render pass folds away, and the grapheme cluster.
    fn scan_cell(
        &self,
        row: usize,
        col: usize,
        rendered: Option<RenderCell>,
        blank: &RenderCell,
        detail: ScreenDetail,
    ) -> ScannedCell {
        // A sparse grid row can be shorter than the declared width; the missing
        // tail is the terminal's implicit blank, not an inherited style.
        let cell = rendered.unwrap_or(*blank);
        let raw = self.cell(row, col).unwrap_or_default().attrs;
        let attrs = attr_codes(&cell, raw.dim, raw.blink, raw.inverse, raw.conceal);
        let hyperlink = match detail {
            ScreenDetail::Full => self
                .engine()
                .hyperlink_at(row as u16, col as u16)
                .map(str::to_string),
            ScreenDetail::Compact => None,
        };
        let text = if cell.wide {
            // The right half of a wide glyph draws nothing of its own; emitting
            // its placeholder space would make `text` misreport the row.
            String::new()
        } else {
            match self.engine().cell_grapheme(row, col) {
                Some(g) if !g.is_empty() => g,
                _ => cell.ch.to_string(),
            }
        };
        let blank = text == " "
            && attrs.is_empty()
            && hyperlink.is_none()
            && cell.fg == blank.fg
            && cell.bg == blank.bg;
        ScannedCell { fg: cell.fg, bg: cell.bg, attrs, hyperlink, text, blank }
    }
}

/// The raw SGR bits as [`SCREEN_ATTR_CODES`] letters. `dim`/`blink`/`inverse`/
/// `conceal` come from the grid because the render pass resolves them into the
/// colours rather than reporting them.
fn attr_codes(cell: &RenderCell, dim: bool, blink: bool, inverse: bool, conceal: bool) -> String {
    let mut out = String::new();
    if cell.bold {
        out.push('b');
    }
    if dim {
        out.push('d');
    }
    if cell.italic {
        out.push('i');
    }
    if blink {
        out.push('k');
    }
    if inverse {
        out.push('v');
    }
    if conceal {
        out.push('c');
    }
    if cell.strikethrough {
        out.push('s');
    }
    if cell.overline {
        out.push('o');
    }
    out.push_str(match cell.underline {
        UnderlineStyle::None => "",
        UnderlineStyle::Single => "u",
        UnderlineStyle::Double => "U",
        UnderlineStyle::Curly => "w",
        UnderlineStyle::Dotted => "t",
        UnderlineStyle::Dashed => "a",
    });
    out
}

fn cursor_style_name(style: CursorStyle) -> &'static str {
    match style {
        CursorStyle::BlinkingBlock => "blinking-block",
        CursorStyle::SteadyBlock => "steady-block",
        CursorStyle::BlinkingUnderline => "blinking-underline",
        CursorStyle::SteadyUnderline => "steady-underline",
        CursorStyle::BlinkingBar => "blinking-bar",
        CursorStyle::SteadyBar => "steady-bar",
        CursorStyle::Hidden => "hidden",
        CursorStyle::HollowBlock => "hollow-block",
        CursorStyle::Bolt => "bolt",
        // `CursorStyle` is #[non_exhaustive]; a shape this build does not know
        // is reported as unknown rather than guessed into a familiar name.
        _ => "unknown",
    }
}

fn mouse_tracking_name(term: &HeadlessTerminal) -> &'static str {
    use crate::headless::MouseTracking;
    match term.mouse_tracking() {
        MouseTracking::None => "none",
        MouseTracking::X10 => "x10",
        MouseTracking::Normal => "normal",
        MouseTracking::Button => "button",
        MouseTracking::Any => "any",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMPACT: StyledFrameOptions = StyledFrameOptions {
        detail: ScreenDetail::Compact,
        from_row: 0,
        row_count: 0,
        max_runs: 0,
    };

    fn full() -> StyledFrameOptions {
        StyledFrameOptions { detail: ScreenDetail::Full, ..COMPACT }
    }

    fn row_text(frame: &StyledFrame, row: usize) -> String {
        frame.grid[row].runs.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn a_plain_row_is_one_run_and_the_tail_of_blanks_is_gone() {
        let mut term = HeadlessTerminal::new(4, 40);
        term.process_str("hello");
        let frame = term.styled_frame(COMPACT);
        assert_eq!((frame.rows, frame.cols), (4, 40));
        assert_eq!(frame.grid.len(), 4);
        assert_eq!(frame.grid[0].runs.len(), 1, "one style across the row, one run");
        assert_eq!(frame.grid[0].runs[0].text, "hello");
        assert_eq!(frame.grid[0].runs[0].cols, 5, "the 35 default blanks were trimmed");
        assert!(frame.grid[1].runs.is_empty(), "an untouched row trims to nothing");
        assert!(frame.trailing_blanks_trimmed);
    }

    #[test]
    fn full_detail_pads_every_row_to_the_declared_width() {
        let mut term = HeadlessTerminal::new(3, 20);
        term.process_str("hi");
        let frame = term.styled_frame(full());
        assert!(!frame.trailing_blanks_trimmed);
        for row in &frame.grid {
            let width: usize = row.runs.iter().map(|r| r.cols).sum();
            assert_eq!(width, 20, "full detail is the lossless rows x cols contract");
        }
        assert_eq!(row_text(&frame, 0), format!("hi{}", " ".repeat(18)));
    }

    #[test]
    fn a_colour_change_splits_the_row_into_runs_with_resolved_rgb() {
        let mut term = HeadlessTerminal::new(2, 20);
        // Default text, then explicit red-on-blue, then back to default.
        term.process_str("ab\x1b[38;2;255;0;0m\x1b[48;2;0;0;255mCD\x1b[0mef");
        let frame = term.styled_frame(COMPACT);
        let runs = &frame.grid[0].runs;
        assert_eq!(runs.len(), 3);
        assert_eq!((runs[0].col, runs[0].text.as_str()), (0, "ab"));
        assert_eq!((runs[1].col, runs[1].text.as_str()), (2, "CD"));
        assert_eq!(runs[1].fg, [255, 0, 0], "colours come back resolved, not as SGR params");
        assert_eq!(runs[1].bg, [0, 0, 255]);
        assert_eq!((runs[2].col, runs[2].text.as_str()), (4, "ef"));
        assert_eq!(runs[0].fg, frame.default_fg, "unstyled text equals the frame default");
    }

    #[test]
    fn an_inverse_highlight_reports_both_the_swapped_colours_and_the_bit() {
        // The keystone case: a TUI's selected row. A driver must be able to see
        // WHICH row is picked, whether it reads pixels or SGR intent.
        let mut term = HeadlessTerminal::new(2, 20);
        term.process_str("plain\r\n\x1b[7mpicked\x1b[0m");
        let frame = term.styled_frame(COMPACT);
        let plain = &frame.grid[0].runs[0];
        let picked = &frame.grid[1].runs[0];
        assert_eq!(picked.attrs, "v", "the raw inverse bit survives the render pass");
        assert_eq!(plain.attrs, "");
        assert_eq!(picked.fg, plain.bg, "inverse is folded into what a viewer sees");
        assert_eq!(picked.bg, plain.fg);
    }

    #[test]
    fn every_attribute_bit_gets_a_code_letter() {
        let mut term = HeadlessTerminal::new(2, 20);
        term.process_str("\x1b[1;2;3;4;5;7;8;9;53mx");
        let attrs = &term.styled_frame(COMPACT).grid[0].runs[0].attrs;
        for code in ['b', 'd', 'i', 'k', 'v', 'c', 's', 'o', 'u'] {
            assert!(attrs.contains(code), "missing {code} in {attrs}");
        }
    }

    #[test]
    fn underline_styles_get_distinct_codes() {
        let mut term = HeadlessTerminal::new(2, 20);
        term.process_str("\x1b[4:3mx\x1b[4:4my\x1b[4:5mz");
        let runs = &term.styled_frame(COMPACT).grid[0].runs;
        let codes: Vec<&str> = runs.iter().map(|r| r.attrs.as_str()).collect();
        assert_eq!(codes, vec!["w", "t", "a"], "curly / dotted / dashed are not one bit");
    }

    #[test]
    fn a_wide_glyph_spans_two_columns_but_contributes_one_grapheme() {
        let mut term = HeadlessTerminal::new(2, 20);
        term.process_str("a漢b");
        let frame = term.styled_frame(COMPACT);
        let runs = &frame.grid[0].runs;
        assert_eq!(runs.len(), 1, "same style throughout");
        assert_eq!(runs[0].text, "a漢b");
        assert_eq!(runs[0].cols, 4, "the continuation column is counted, not textualized");
    }

    #[test]
    fn the_cursor_position_shape_and_visibility_come_back() {
        let mut term = HeadlessTerminal::new(6, 30);
        term.process_str("\x1b[3;7H\x1b[5 q");
        let frame = term.styled_frame(COMPACT);
        assert_eq!((frame.cursor.row, frame.cursor.col), (2, 6), "0-based, as the grid is");
        assert!(frame.cursor.visible);
        assert_eq!(frame.cursor.style, "blinking-bar");
        term.process_str("\x1b[?25l");
        let hidden = term.styled_frame(COMPACT);
        assert!(!hidden.cursor.visible);
        assert_eq!((hidden.cursor.row, hidden.cursor.col), (2, 6), "hidden still has a position");
    }

    #[test]
    fn the_modes_that_change_what_input_means_are_reported() {
        let mut term = HeadlessTerminal::new(4, 20);
        let off = term.styled_frame(COMPACT).modes;
        assert!(!off.alternate_screen && !off.application_cursor && !off.bracketed_paste);
        assert_eq!(off.mouse_tracking, "none");
        assert_eq!(off.kitty_keyboard_flags, 0);
        term.process_str("\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[>1u");
        let on = term.styled_frame(COMPACT).modes;
        assert!(on.alternate_screen, "an agent TUI lives here");
        assert!(on.application_cursor, "DECCKM: arrows are ESC O A, not ESC [ A");
        assert!(on.bracketed_paste);
        assert_eq!(on.mouse_tracking, "any");
        assert!(on.sgr_mouse);
        assert_eq!(on.kitty_keyboard_flags, 1);
    }

    #[test]
    fn decscnm_inverts_the_frame_default_and_says_so() {
        let mut term = HeadlessTerminal::new(2, 10);
        let normal = term.styled_frame(COMPACT);
        term.process_str("\x1b[?5h");
        let reversed = term.styled_frame(COMPACT);
        assert!(!normal.modes.reverse_video && reversed.modes.reverse_video);
        assert_eq!(reversed.default_bg, normal.default_fg);
        assert_eq!(reversed.default_fg, normal.default_bg);
    }

    #[test]
    fn a_hyperlink_is_attached_in_full_detail_and_absent_in_compact() {
        let mut term = HeadlessTerminal::new(2, 30);
        term.process_str("\x1b]8;;https://example.com\x07link\x1b]8;;\x07 tail");
        let compact = term.styled_frame(COMPACT);
        assert!(
            compact.grid[0].runs.iter().all(|r| r.hyperlink.is_none()),
            "compact does not probe: None here means 'not asked'"
        );
        let full = term.styled_frame(full());
        let linked = full.grid[0]
            .runs
            .iter()
            .find(|r| r.hyperlink.is_some())
            .expect("full detail carries OSC-8 targets");
        assert_eq!(linked.text, "link");
        assert_eq!(linked.hyperlink.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn a_row_window_reports_its_offset_and_that_it_is_partial() {
        let mut term = HeadlessTerminal::new(8, 20);
        for row in 0..8 {
            term.process_str(&format!("row{row}\r\n"));
        }
        let frame = term.styled_frame(StyledFrameOptions {
            from_row: 2,
            row_count: 3,
            ..COMPACT
        });
        assert_eq!(frame.first_row, 2);
        assert_eq!(frame.grid.len(), 3);
        assert_eq!(frame.grid[0].row, 2, "rows carry their true grid index");
        assert!(frame.rows_truncated, "a window is not the screen and must say so");
        assert_eq!(frame.rows, 8, "the full height is still reported");
    }

    #[test]
    fn the_run_budget_cuts_whole_rows_and_never_the_first_one() {
        let mut term = HeadlessTerminal::new(6, 20);
        for _ in 0..6 {
            term.process_str("\x1b[31ma\x1b[32mb\x1b[33mc\x1b[0m\r\n");
        }
        let frame = term.styled_frame(StyledFrameOptions { max_runs: 4, ..COMPACT });
        assert_eq!(frame.grid.len(), 1, "3 runs fit, the next row's 3 would not");
        assert_eq!(frame.grid[0].runs.len(), 3, "the served row is whole");
        assert!(frame.rows_truncated);
        assert_eq!(frame.runs_total, 3);

        let tiny = term.styled_frame(StyledFrameOptions { max_runs: 1, ..COMPACT });
        assert_eq!(tiny.grid.len(), 1, "an empty grid would read as a blank screen");
        assert!(tiny.rows_truncated);
    }

    #[test]
    fn an_unwritten_grid_is_blank_rather_than_missing() {
        let term = HeadlessTerminal::new(3, 10);
        let frame = term.styled_frame(COMPACT);
        assert_eq!(frame.grid.len(), 3);
        assert!(frame.grid.iter().all(|row| row.runs.is_empty()));
        assert!(!frame.rows_truncated, "the whole screen was served — it is simply empty");
    }

    #[test]
    fn the_frame_reads_the_live_screen_not_scrolled_history() {
        let mut term = HeadlessTerminal::new(3, 20);
        for row in 0..10 {
            term.process_str(&format!("line{row}\r\n"));
        }
        let frame = term.styled_frame(COMPACT);
        assert!(term.scrollback_len() > 0, "rows did scroll off");
        assert_eq!(row_text(&frame, 0), "line8", "the grid is the live screen");
        assert_eq!(frame.grid.len(), 3);
    }

    #[test]
    fn content_seq_moves_only_when_the_cells_do() {
        let mut term = HeadlessTerminal::new(3, 20);
        term.process_str("x");
        let first = term.styled_frame(COMPACT).content_seq;
        assert_eq!(term.styled_frame(COMPACT).content_seq, first, "a re-read is stable");
        term.process_str("y");
        assert_ne!(term.styled_frame(COMPACT).content_seq, first);
    }
}
