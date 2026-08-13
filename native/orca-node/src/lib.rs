//! Node-API addon exposing the ATERM-backed `orca_terminal::HeadlessTerminal`
//! to the Electron main/daemon process. Mirrors the surface
//! `src/main/daemon/headless-emulator.ts` needs (write / resize / snapshot /
//! cwd / cursor / mouse-modes / serialize) so it can be swapped in behind the
//! `ORCA_RUST_TERMINAL` flag. This is the real JS -> napi -> aterm path.
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

// The IO-tier "A bridge": run orca-git's sync GitRunner logic over an async JS
// git executor (Rust drives, JS executes — SSH-safe).
mod git_executor_bridge;

// `terminal.screen`'s nested frame shape (rows -> runs, cursor, modes).
mod styled_screen;

const DEFAULT_SCROLLBACK: u32 = 5000;

/// One OSC-8 hyperlink run in a snapshot. Field names marshal to camelCase
/// (`startCol`/`endCol`), matching the renderer's `TerminalOscLinkRange`.
/// `endCol` is exclusive.
#[napi(object)]
pub struct JsOscLinkRange {
    pub row: u32,
    pub start_col: u32,
    pub end_col: u32,
    pub uri: String,
}

/// One federated-search match summary (E-5). `absRow` is 0-based from the
/// oldest retained history row; `col`/`len` are char offsets into `line`.
#[napi(object)]
pub struct JsSearchMatch {
    pub abs_row: u32,
    pub col: u32,
    pub len: u32,
    pub line: String,
}

/// Newest-first summaries plus the true total and the fed-design truncation
/// honesty flag. `originRow` (fed §2.4 remote wire) is the stable absolute row
/// of retained index 0 AT SEARCH TIME, read in the same settled state as the
/// matches so `originRow + absRow` is an eviction-stable host row.
#[napi(object)]
pub struct JsSearchOutcome {
    pub matches: Vec<JsSearchMatch>,
    pub total: u32,
    pub incomplete: bool,
    pub origin_row: f64,
}

/// Context window around an absolute row (`searchContext` contract).
/// `originRow`: same stable-row origin contract as [`JsSearchOutcome`].
#[napi(object)]
pub struct JsSearchContextWindow {
    pub lines: Vec<String>,
    pub first_abs_row: u32,
    pub origin_row: f64,
}

/// One keystroke encoded against a pane's LIVE keyboard modes (`terminal.key`).
///
/// `recognized` and the byte count answer two different questions, and the
/// caller has to be able to tell them apart: an unknown key name is the caller's
/// mistake, while a known key that encodes to nothing is the pane's modes
/// speaking. Collapsing them would leave a driver retrying a typo forever.
#[napi(object)]
pub struct JsKeyEncoding {
    /// The engine's key table knows this name.
    pub recognized: bool,
    /// Key-down bytes. Empty on a recognized key = no encoding in these modes.
    pub press: Buffer,
    /// Key-up bytes; empty unless the pane negotiated Kitty `REPORT_EVENT_TYPES`.
    pub release: Buffer,
    /// `KeyboardMode` bits the encoding was made against — the audit trail for
    /// why these bytes and not the other ones.
    pub mode_bits: u32,
}

/// One inline image on the visible grid (`terminal.images`). One entry per
/// PLACEMENT, not per covered cell.
///
/// `payloadState` is the honesty field: `included` / `not-requested` /
/// `too-large` / `budget-exhausted`. `base64` is set only for `included` — an
/// oversized payload is withheld whole, never truncated, because a prefix of a
/// PNG is a corrupt PNG rather than a smaller one.
#[napi(object)]
pub struct JsInlineImage {
    /// Top-left of the covered bounding box, in visible-grid coordinates.
    pub row: u32,
    pub col: u32,
    /// The FULL footprint as placed; `coveredCells` says how much is on screen.
    pub cell_rows: u32,
    pub cell_cols: u32,
    pub covered_cells: u32,
    /// `png` | `rgba8` | `unknown`.
    pub format: String,
    /// Source raster size — `rgba8` (sixel) only; null for container formats
    /// whose header this layer deliberately does not parse.
    pub pixel_width: Option<u32>,
    pub pixel_height: Option<u32>,
    /// Retained payload size, reported whether or not the bytes came back. f64
    /// because a payload can exceed u32 in principle (engine cap is 16 MiB).
    pub byte_len: f64,
    /// Kitty `z=`: negative draws behind the cell's text.
    pub z_index: i32,
    /// FNV-1a 64 as hex — an identity hint for polling callers, not a checksum.
    pub fingerprint: String,
    pub payload_state: String,
    pub base64: Option<String>,
}

#[napi(js_name = "HeadlessTerminal")]
pub struct JsHeadlessTerminal {
    // Option so dispose() can drop the engine (grid + tiered scrollback)
    // deterministically instead of waiting for the GC finalizer; disposed
    // calls return empty defaults.
    inner: Option<orca_terminal::HeadlessTerminal>,
}

// Every export carries catch_unwind: a Rust panic unwinding across the extern-C
// napi boundary aborts the whole daemon/Electron-main process (all sessions);
// catch_unwind converts it into a JS exception the caller can contain per-session.
#[napi]
impl JsHeadlessTerminal {
    /// JS passes (cols, rows); the engine takes (rows, cols) internally.
    #[napi(constructor, catch_unwind)]
    pub fn new(cols: u32, rows: u32, scrollback: Option<u32>) -> Self {
        let scrollback = scrollback.unwrap_or(DEFAULT_SCROLLBACK) as usize;
        Self {
            inner: Some(orca_terminal::HeadlessTerminal::with_scrollback(
                rows as usize,
                cols as usize,
                scrollback,
            )),
        }
    }

    #[napi(catch_unwind)]
    pub fn write(&mut self, data: Buffer) {
        if let Some(inner) = self.inner.as_mut() {
            inner.process(&data);
        }
    }

    #[napi(catch_unwind)]
    pub fn resize(&mut self, cols: u32, rows: u32) {
        if let Some(inner) = self.inner.as_mut() {
            inner.resize(rows as usize, cols as usize);
        }
    }

    /// Visible grid rows (trailing blanks trimmed) — the render snapshot.
    #[napi(catch_unwind)]
    pub fn snapshot(&self) -> Vec<String> {
        self.inner.as_ref().map(|t| t.snapshot()).unwrap_or_default()
    }

    #[napi(catch_unwind)]
    pub fn scrollback_len(&self) -> u32 {
        self.inner.as_ref().map_or(0, |t| t.scrollback_len() as u32)
    }

    #[napi(catch_unwind)]
    pub fn clear_scrollback(&mut self) {
        if let Some(inner) = self.inner.as_mut() {
            inner.clear_scrollback();
        }
    }

    /// Replayable ANSI for the snapshot (scrollback + visible grid). `&mut` so
    /// the adapter can memoise the result by content-generation + cursor.
    /// `scrollbackRows` caps the prepended history (omit = all, 0 = viewport-only),
    /// matching `@xterm/addon-serialize`'s `serialize({scrollback})`.
    #[napi(catch_unwind)]
    pub fn serialize_ansi(&mut self, scrollback_rows: Option<u32>) -> String {
        self.inner
            .as_mut()
            .map(|t| t.serialize_ansi(scrollback_rows.map(|n| n as usize)))
            .unwrap_or_default()
    }

    /// Scrollback history only (no grid/cursor framing) — what the daemon stores
    /// in `scrollbackAnsi` so alt-screen sessions restore their scrollback.
    /// `maxRows` caps to the most-recent N history lines (omit = all).
    #[napi(catch_unwind)]
    pub fn serialize_scrollback_ansi(&self, max_rows: Option<u32>) -> String {
        self.inner
            .as_ref()
            .map(|t| t.serialize_scrollback_ansi(max_rows.map(|n| n as usize)))
            .unwrap_or_default()
    }

    /// OSC-8 hyperlink ranges over the serialized window (the same `scrollbackRows`
    /// of history `serializeAnsi` prepends, then the visible grid), so restored
    /// snapshots keep clickable links.
    #[napi(catch_unwind)]
    pub fn osc_link_ranges(&self, scrollback_rows: Option<u32>) -> Vec<JsOscLinkRange> {
        let Some(inner) = self.inner.as_ref() else {
            return Vec::new();
        };
        inner
            .osc_link_ranges(scrollback_rows.map(|n| n as usize))
            .into_iter()
            .map(|r| JsOscLinkRange {
                row: r.row as u32,
                start_col: r.start_col as u32,
                end_col: r.end_col as u32,
                uri: r.uri,
            })
            .collect()
    }

    /// Window title (OSC 0/2), or null when unset — feeds the snapshot's
    /// `lastTitle` for agent detection.
    #[napi(catch_unwind)]
    pub fn title(&self) -> Option<String> {
        self.inner.as_ref().and_then(|t| t.title())
    }

    #[napi(catch_unwind)]
    pub fn cwd(&self) -> Option<String> {
        self.inner
            .as_ref()
            .and_then(|t| t.cwd().map(str::to_string))
    }

    /// `[row, col]` cursor position.
    #[napi(catch_unwind)]
    pub fn cursor(&self) -> Vec<u32> {
        let (r, c) = self.inner.as_ref().map_or((0, 0), |t| t.cursor());
        vec![r as u32, c as u32]
    }

    #[napi(catch_unwind)]
    pub fn mouse_tracking(&self) -> String {
        use orca_terminal::MouseTracking::{Any, Button, Normal, None as MtNone, X10};
        // Capitalised variant names — the daemon factory's RUST_MOUSE_MODE map
        // keys on these (None/X10/Normal/Button/Any).
        match self.inner.as_ref().map(|t| t.mouse_tracking()) {
            None | Some(MtNone) => "None",
            Some(X10) => "X10",
            Some(Normal) => "Normal",
            Some(Button) => "Button",
            Some(Any) => "Any",
        }
        .to_string()
    }

    #[napi(catch_unwind)]
    pub fn sgr_mouse(&self) -> bool {
        self.inner.as_ref().is_some_and(|t| t.sgr_mouse())
    }

    #[napi(catch_unwind)]
    pub fn sgr_pixels(&self) -> bool {
        self.inner.as_ref().is_some_and(|t| t.sgr_pixels())
    }

    #[napi(catch_unwind)]
    pub fn is_alternate_screen(&self) -> bool {
        self.inner.as_ref().is_some_and(|t| t.is_alternate_screen())
    }

    #[napi(catch_unwind)]
    pub fn bracketed_paste(&self) -> bool {
        self.inner.as_ref().is_some_and(|t| t.bracketed_paste())
    }

    #[napi(catch_unwind)]
    pub fn application_cursor(&self) -> bool {
        self.inner.as_ref().is_some_and(|t| t.application_cursor())
    }

    /// E-5 federated search over history + visible grid (fed design §2.2: the
    /// main-process entry for parked/stored content — ANSI is stripped by the
    /// headless parse, never a TS regex). Invalid regex yields zero matches.
    /// `&mut` because retention settles first (serialize_ansi's contract).
    #[napi(catch_unwind)]
    pub fn search_scrollback(
        &mut self,
        query: String,
        case_sensitive: Option<bool>,
        regex: Option<bool>,
        max_matches: Option<u32>,
        cutoff_row: Option<u32>,
    ) -> JsSearchOutcome {
        let Some(inner) = self.inner.as_mut() else {
            return JsSearchOutcome { matches: Vec::new(), total: 0, incomplete: false, origin_row: 0.0 };
        };
        let opts = orca_terminal::SearchOptions {
            case_sensitive: case_sensitive.unwrap_or(false),
            regex: regex.unwrap_or(false),
        };
        let outcome = inner.search_scrollback(
            &query,
            opts,
            max_matches.unwrap_or(50) as usize,
            cutoff_row.map(|c| c as usize),
        );
        // After the search settled retention: same coordinate state as the matches.
        let origin_row = inner.retained_origin_row() as f64;
        JsSearchOutcome {
            matches: outcome
                .matches
                .into_iter()
                .map(|m| JsSearchMatch {
                    abs_row: m.abs_row as u32,
                    col: m.col as u32,
                    len: m.len as u32,
                    line: m.line,
                })
                .collect(),
            total: outcome.total as u32,
            incomplete: outcome.incomplete,
            origin_row,
        }
    }

    /// Context lines around an absolute row, clamped to retained content.
    #[napi(catch_unwind)]
    pub fn search_context(&mut self, abs_row: u32, before: u32, after: u32) -> JsSearchContextWindow {
        let Some(inner) = self.inner.as_mut() else {
            return JsSearchContextWindow { lines: Vec::new(), first_abs_row: 0, origin_row: 0.0 };
        };
        let (lines, first) =
            inner.search_context(abs_row as usize, before as usize, after as usize);
        let origin_row = inner.retained_origin_row() as f64;
        JsSearchContextWindow { lines, first_abs_row: first as u32, origin_row }
    }

    /// Inline images (iTerm2 OSC 1337 / sixel / Kitty) currently on the VISIBLE
    /// grid, in reading order — one entry per placement.
    ///
    /// An empty result means "none on screen now", never "this pane emitted
    /// none": the engine drops image refs when a row scrolls off, so a caller
    /// must pair this with the retained-history depth to tell those apart.
    /// Metadata-only unless `includeBytes`; the two byte budgets are applied
    /// exactly as given (Orca clamps them at the RPC edge).
    #[napi(catch_unwind)]
    pub fn inline_images(
        &self,
        include_bytes: Option<bool>,
        max_bytes_per_image: Option<f64>,
        max_total_bytes: Option<f64>,
    ) -> Vec<JsInlineImage> {
        let Some(inner) = self.inner.as_ref() else {
            return Vec::new();
        };
        let budget = |value: Option<f64>| -> usize {
            value.filter(|v| v.is_finite() && *v > 0.0).map_or(0, |v| v as usize)
        };
        let placements = inner.inline_images(orca_terminal::InlineImageReadOptions {
            include_bytes: include_bytes.unwrap_or(false),
            max_bytes_per_image: budget(max_bytes_per_image),
            max_total_bytes: budget(max_total_bytes),
        });
        placements
            .into_iter()
            .map(|image| {
                let (format, pixel_width, pixel_height) = match image.encoding {
                    orca_terminal::InlineImageEncoding::Png => ("png", None, None),
                    orca_terminal::InlineImageEncoding::Rgba8 { width, height } => {
                        ("rgba8", Some(u32::from(width)), Some(u32::from(height)))
                    }
                    orca_terminal::InlineImageEncoding::Unknown => ("unknown", None, None),
                };
                let (payload_state, base64) = match image.payload {
                    orca_terminal::InlineImagePayload::NotRequested => ("not-requested", None),
                    orca_terminal::InlineImagePayload::TooLarge => ("too-large", None),
                    orca_terminal::InlineImagePayload::BudgetExhausted => {
                        ("budget-exhausted", None)
                    }
                    orca_terminal::InlineImagePayload::Base64(encoded) => {
                        ("included", Some(encoded))
                    }
                };
                JsInlineImage {
                    row: image.row as u32,
                    col: image.col as u32,
                    cell_rows: u32::from(image.cell_rows),
                    cell_cols: u32::from(image.cell_cols),
                    covered_cells: image.covered_cells as u32,
                    format: format.to_string(),
                    pixel_width,
                    pixel_height,
                    byte_len: image.byte_len as f64,
                    z_index: image.z_index,
                    fingerprint: format!("{:016x}", image.fingerprint),
                    payload_state: payload_state.to_string(),
                    base64,
                }
            })
            .collect()
    }

    /// The styled VISIBLE grid plus the cursor and the input-affecting modes
    /// (`terminal.screen`) — the one read that is not text.
    ///
    /// Colours are fully resolved by the engine (palette, bold-to-bright, dim,
    /// inverse, DECSCNM), so a run's `fg`/`bg` is what a viewer sees; the raw
    /// SGR bits ride alongside in `attrs`. Cells are coalesced into runs because
    /// a per-cell grid is far larger than the text it carries.
    ///
    /// `detail`: `full` pads every row to the grid width and attaches OSC-8
    /// targets; anything else is the compact read (trailing default blanks
    /// dropped, hyperlinks not probed). `fromRow`/`rowCount` window the rows
    /// (`rowCount` 0 = to the bottom) and `maxRuns` bounds the payload; both
    /// cut WHOLE rows and set `rowsTruncated`.
    ///
    /// Scope is the live screen only. Scrolled-off rows are retained as text
    /// with their colour discarded, so styled history does not exist to return.
    ///
    /// Null when the engine has been disposed — a zeroed frame would describe a
    /// blank 0x0 screen, which is a fact, and "I could not look" is not.
    #[napi(catch_unwind)]
    pub fn styled_frame(
        &self,
        detail: Option<String>,
        from_row: Option<u32>,
        row_count: Option<u32>,
        max_runs: Option<u32>,
    ) -> Option<styled_screen::JsStyledFrame> {
        let inner = self.inner.as_ref()?;
        Some(styled_screen::to_js_frame(inner.styled_frame(
            orca_terminal::StyledFrameOptions {
                detail: match detail.as_deref() {
                    Some("full") => orca_terminal::ScreenDetail::Full,
                    _ => orca_terminal::ScreenDetail::Compact,
                },
                from_row: from_row.unwrap_or(0) as usize,
                row_count: row_count.unwrap_or(0) as usize,
                max_runs: max_runs.unwrap_or(0) as usize,
            },
        )))
    }

    /// Encode ONE keystroke against this pane's current keyboard modes
    /// (`terminal.key`) — the input counterpart of `styled_frame`.
    ///
    /// `key` is a DOM `KeyboardEvent.key` value; `mods` is the engine
    /// `Modifiers` bitfield (SHIFT=1, ALT=2, CTRL=4, SUPER=8). The engine, not
    /// the caller, decides what the bytes are: DECCKM, the negotiated Kitty
    /// flags, xterm modifyOtherKeys, DECBKM and the 1035/1036/1039 family all
    /// change the answer for the same key, which is exactly why encoding this
    /// in TypeScript would drift from the engine that interprets it.
    ///
    /// Null when the engine has been disposed — never a zeroed encoding, which
    /// would read as "this key means nothing here".
    #[napi(catch_unwind)]
    pub fn encode_key(&self, key: String, mods: u32) -> Option<JsKeyEncoding> {
        let inner = self.inner.as_ref()?;
        // Truncating past 8 bits is safe: every bit above them is a lock or a
        // platform modifier the engine masks off anyway.
        let encoded = inner.encode_key(&key, mods as u8);
        Some(JsKeyEncoding {
            recognized: encoded.recognized,
            press: encoded.press.into(),
            release: encoded.release.into(),
            mode_bits: u32::from(encoded.mode_bits),
        })
    }

    /// Stable absolute row of retained history index 0 (fed §2.4): monotonic
    /// across eviction/clear, never reused, settled before read — the host-row
    /// coordinate the remote-search snapshot anchor is expressed in.
    #[napi(catch_unwind)]
    pub fn retained_origin_row(&mut self) -> f64 {
        self.inner.as_mut().map_or(0.0, |t| t.retained_origin_row() as f64)
    }

    /// Drop the engine now. The daemon churns through many sessions, so freeing
    /// the multi-MB grid/scrollback must not wait for a GC finalizer.
    #[napi(catch_unwind)]
    pub fn dispose(&mut self) {
        self.inner = None;
    }
}

#[napi(catch_unwind)]
pub fn engine() -> String {
    "aterm".to_string()
}

// --- orca-git: the verified status/numstat/line-count parsers, exposed to JS
// via this same .node. They are the SOLE implementation in the main process
// (the duplicated TS parsers were deleted after the dual-run parity phase; the
// relay runs the same core via wasm). JSON strings are the marshalling format
// (the status_result.rs builders match the original TS shapes verbatim,
// omitting None fields). ---

/// Streaming `git status --porcelain=v2 --branch` parser — the chunked path the
/// daemon feeds raw stdout bytes. Ported from the (since deleted)
/// `StatusPorcelainParser` in `src/main/git/status-porcelain-parser.ts`.
#[napi(js_name = "GitStatusParser")]
pub struct JsGitStatusParser {
    // Option because into_result consumes the parser; result() take()s it.
    inner: Option<orca_git::status_stream::StatusPorcelainParser>,
}

#[napi]
impl JsGitStatusParser {
    #[napi(constructor, catch_unwind)]
    pub fn new() -> Self {
        Self {
            inner: Some(orca_git::status_stream::StatusPorcelainParser::new()),
        }
    }

    /// Feed one raw chunk. Returns true once the changed-entry count exceeds
    /// `limit` (0 disables the cap), signaling the caller to stop git.
    #[napi(catch_unwind)]
    pub fn update(&mut self, chunk: Buffer, limit: u32) -> bool {
        match self.inner.as_mut() {
            Some(parser) => parser.update(&chunk, limit as usize),
            // Already consumed by result(); nothing more to scan.
            None => false,
        }
    }

    /// Flush a final record with no trailing newline (e.g. when git exits).
    #[napi(catch_unwind)]
    pub fn finish(&mut self) {
        if let Some(parser) = self.inner.as_mut() {
            parser.finish();
        }
    }

    /// Consume the parser and return the status-result JSON. After the first call
    /// the parser is gone; a second call returns a valid empty result, never a panic.
    #[napi(catch_unwind)]
    pub fn result(&mut self, limit: u32) -> String {
        let result = match self.inner.take() {
            Some(parser) => parser.into_result(limit as usize),
            None => orca_git::status_stream::StatusPorcelainParser::new().into_result(limit as usize),
        };
        orca_git::status_result::status_parse_result_to_json(&result).to_string()
    }
}

/// One-shot status scan (the relay entry point): the cap is applied DURING the
/// scan, so `entries` is bounded by `limit` instead of materialize-then-truncate.
#[napi(catch_unwind)]
pub fn parse_status_porcelain(stdout: Buffer, limit: u32) -> String {
    let result = orca_git::status_stream::parse_status_porcelain(&stdout, limit as usize);
    orca_git::status_result::status_parse_result_to_json(&result).to_string()
}

/// `git diff --numstat` (text or `-z`) parsed to `{path: {added?, removed?}}`.
#[napi(catch_unwind)]
pub fn parse_numstat(stdout: Buffer) -> String {
    let entries = orca_git::numstat::parse_numstat(&stdout);
    orca_git::status_result::numstat_to_json(&entries).to_string()
}

/// `git worktree list --porcelain` (or the `-z` NUL form) parsed to the
/// `GitWorktreeInfo[]` JSON the TS `parseWorktreeList` produces (`isSparse`
/// omitted when false).
#[napi(catch_unwind)]
pub fn parse_worktree_list(output: String, nul_delimited: bool) -> String {
    let worktrees = orca_git::worktree::parse_worktree_list(&output, nul_delimited);
    orca_git::worktree::worktree_list_to_json(&worktrees).to_string()
}

/// NUL-delimited `git log` output (in `GIT_HISTORY_COMMIT_FORMAT`) parsed to the
/// `GitHistoryItem[]` JSON the TS `parseGitHistoryLog` produces.
#[napi(catch_unwind)]
pub fn parse_git_history_log(stdout: String) -> String {
    let items = orca_git::git_history_log_parser::parse_git_history_log(&stdout);
    orca_git::git_history_log_parser::git_history_log_to_json(&items).to_string()
}

/// Count additions for an untracked file's contents: null for binary, 0 for empty,
/// else the trailing-newline-aware line count.
#[napi(catch_unwind)]
pub fn count_additions_in_buffer(bytes: Buffer) -> Option<u32> {
    orca_git::line_count::count_additions_in_buffer(&bytes)
}

/// Validate a persisted push target's *value* rules — the substantive
/// path-traversal-safety check for a remote name / branch name / optional GitHub
/// URL that gets replayed into `git push`. Returns the TS-identical error message,
/// or `None` when valid. The `unknown`→typed guards (and their `Invalid PR push
/// target …` messages) stay in JS; this shares `orca_core` with the parity harness.
#[napi(catch_unwind)]
pub fn validate_git_push_target_rules(
    remote_name: String,
    branch_name: String,
    remote_url: Option<String>,
) -> Option<String> {
    orca_core::git_push_target::validate_git_push_target(
        &remote_name,
        &branch_name,
        remote_url.as_deref(),
    )
    .err()
}

/// Approximate added/removed line counts; returns the line-stats JSON, or null
/// for the large-input guard.
#[napi(catch_unwind)]
pub fn compute_line_stats(original: String, modified: String, status: String) -> Option<String> {
    orca_git::line_count::compute_line_stats(&original, &modified, &status)
        .map(|stats| orca_git::status_result::line_stats_to_json(Some(stats)).to_string())
}

/// Decode a git C-quoted (octal-escaped) path. Raw (unquoted) input passes through.
/// js_name keeps the capital-Q the TS `decodeGitCQuotedPath` uses (napi would
/// otherwise lowercase "cquoted").
#[napi(js_name = "decodeGitCQuotedPath", catch_unwind)]
pub fn decode_git_cquoted_path(value: String) -> String {
    orca_core::git_cquoted_path::decode_git_cquoted_path(&value)
}

/// True when a git fetch/pull error message means the remote ref does not
/// exist (an expected state, not a failure). The `unknown`→message extraction
/// stays at the JS boundary.
#[napi(catch_unwind)]
pub fn is_missing_remote_ref_git_error(message: String) -> bool {
    orca_git::fetch_error_classification::is_missing_remote_ref_git_error(&message)
}

fn clone_path_flavor(platform: &str) -> orca_core::cross_platform_path::PathFlavor {
    if platform == "win32" {
        orca_core::cross_platform_path::PathFlavor::Windows
    } else {
        orca_core::cross_platform_path::PathFlavor::Posix
    }
}

/// Derive the default `git clone` folder name from a URL; throws the
/// TS-identical message for names that would escape the destination.
#[napi(catch_unwind)]
pub fn derive_clone_repo_name_from_url(url: String) -> napi::Result<String> {
    orca_git::repo_clone_path::derive_clone_repo_name_from_url(&url)
        .map_err(napi::Error::from_reason)
}

/// Derive `<destination>/<repoName>` for `git clone`, validating the
/// destination is absolute and the result stays inside it. `platform` is the
/// Node `process.platform` value ("win32" → Windows path rules, else POSIX).
#[napi(catch_unwind)]
pub fn derive_validated_clone_path(
    url: String,
    destination: String,
    platform: String,
) -> napi::Result<String> {
    orca_git::repo_clone_path::derive_validated_clone_path(
        &url,
        &destination,
        clone_path_flavor(&platform),
    )
    .map_err(napi::Error::from_reason)
}

/// Stable key for comparing clone paths (WSL-UNC aware). Callers pass an
/// already-resolved absolute path — the cwd `resolve()` stays in JS.
#[napi(catch_unwind)]
pub fn get_clone_path_comparison_key(clone_path: String) -> String {
    orca_git::repo_clone_path::get_clone_path_comparison_key(&clone_path)
}

/// Normalise a git remote-operation error message into the user-facing string.
/// `message` is `None` for a non-Error throw (fixed fallback); `operation` is
/// `"push" | "pull" | "fetch" | "upstream"` (unrecognised → `None`), matching
/// the TS default-parameter behaviour. Mirrors the wasm export the relay runs.
#[napi(catch_unwind)]
pub fn normalize_git_error_message(message: Option<String>, operation: Option<String>) -> String {
    let operation = match operation.as_deref() {
        Some("push") => Some(orca_text::git_remote_error::GitRemoteOperation::Push),
        Some("pull") => Some(orca_text::git_remote_error::GitRemoteOperation::Pull),
        Some("fetch") => Some(orca_text::git_remote_error::GitRemoteOperation::Fetch),
        Some("upstream") => Some(orca_text::git_remote_error::GitRemoteOperation::Upstream),
        _ => None,
    };
    orca_text::git_remote_error::normalize_git_error_message(message.as_deref(), operation)
}

/// True only for clearly-no-upstream signals (an expected state, gated on a
/// `fatal:` prefix). `None` message → false (a non-Error throw in TS).
#[napi(catch_unwind)]
pub fn is_no_upstream_error(message: Option<String>) -> bool {
    orca_text::git_remote_error::is_no_upstream_error(message.as_deref())
}

/// Scrub credentials embedded in a git URL within `message` (keeps SSH
/// user-info; strips `user:password@` on any scheme + HTTP(S) token-only
/// `user@`).
#[napi(catch_unwind)]
pub fn strip_credentials_from_message(message: String) -> String {
    orca_text::git_remote_error::strip_credentials_from_message(&message)
}

/// Which Pi-compatible agent a launch command starts: `"omp"` for OMP
/// (`omp` / `omp.sh`), else `"pi"`.
#[napi(catch_unwind)]
pub fn detect_pi_agent_kind_from_command(command: Option<String>) -> String {
    match orca_text::pi_agent_kind::detect_pi_agent_kind_from_command(command.as_deref()) {
        orca_text::pi_agent_kind::PiAgentKind::Omp => "omp".to_string(),
        orca_text::pi_agent_kind::PiAgentKind::Pi => "pi".to_string(),
    }
}

/// Skill markdown frontmatter summary (`name`/`description`) as JSON.
#[napi(catch_unwind)]
pub fn summarize_skill_markdown(markdown: String) -> String {
    let summary = orca_text::skill_metadata::summarize_skill_markdown(&markdown);
    let mut out = serde_json::Map::new();
    if let Some(name) = summary.name {
        out.insert("name".to_string(), serde_json::Value::String(name));
    }
    if let Some(description) = summary.description {
        out.insert("description".to_string(), serde_json::Value::String(description));
    }
    serde_json::Value::Object(out).to_string()
}

/// Plan a commit-message generation as the TS `CommitMessagePlanResult` union
/// (`{ok:true, plan:{binary,args,stdinPayload,label}} | {ok:false, error}`) JSON.
/// Input is the `CommitMessagePlanInput` object as JSON + the prompt.
#[napi(catch_unwind)]
pub fn plan_commit_message_generation(plan_input_json: String, prompt: String) -> String {
    commit_message_plan_result_to_json(&plan_input_json, &prompt)
}

/// Resolve the spawn binary + prefix args from an optional command override, as
/// `{ok:true, binary, prefixArgs} | {ok:false, error}` JSON.
#[napi(catch_unwind)]
pub fn plan_agent_binary(default_binary: String, command_override: Option<String>) -> String {
    plan_agent_binary_result_to_json(&default_binary, command_override.as_deref())
}

fn commit_message_plan_result_to_json(plan_input_json: &str, prompt: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(plan_input_json) else {
        return serde_json::json!({ "ok": false, "error": "Invalid plan input JSON." }).to_string();
    };
    let input = orca_agents::CommitMessagePlanInput {
        agent_id: value.get("agentId").and_then(|v| v.as_str()).unwrap_or_default(),
        model: value.get("model").and_then(|v| v.as_str()).unwrap_or_default(),
        thinking_level: value.get("thinkingLevel").and_then(|v| v.as_str()),
        custom_agent_command: value.get("customAgentCommand").and_then(|v| v.as_str()),
        agent_command_override: value.get("agentCommandOverride").and_then(|v| v.as_str()),
        agent_args: value.get("agentArgs").and_then(|v| v.as_str()),
    };
    match orca_agents::plan_commit_message_generation(&input, prompt) {
        // TS always emits stdinPayload as an explicit string|null (never absent).
        Ok(plan) => serde_json::json!({
            "ok": true,
            "plan": {
                "binary": plan.binary,
                "args": plan.args,
                "stdinPayload": plan.stdin_payload,
                "label": plan.label,
            }
        })
        .to_string(),
        Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
    }
}

fn plan_agent_binary_result_to_json(default_binary: &str, command_override: Option<&str>) -> String {
    match orca_agents::plan_agent_binary(default_binary, command_override) {
        Ok((binary, prefix_args)) => {
            serde_json::json!({ "ok": true, "binary": binary, "prefixArgs": prefix_args }).to_string()
        }
        Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
    }
}

/// Build the PR-fields generation prompt (TS `buildPullRequestFieldsPrompt`).
/// `context_json` is the `PullRequestDraftContext` object; returns the prompt string.
#[napi(catch_unwind)]
pub fn build_pull_request_fields_prompt(context_json: String, custom_prompt: String) -> String {
    orca_agents::build_pull_request_fields_prompt(&parse_pull_request_context(&context_json), &custom_prompt)
}

/// Parse an agent's PR-fields JSON reply (TS `parseGeneratedPullRequestFields`) as
/// `{ok:true, fields:{base,title,body,draft}} | {ok:false, error}` JSON; `fallback_json`
/// supplies the current PR fields for missing/blank values (the shim throws on `!ok`).
#[napi(catch_unwind)]
pub fn parse_generated_pull_request_fields(raw: String, fallback_json: String) -> String {
    let fallback = parse_pull_request_context(&fallback_json);
    match orca_agents::parse_generated_pull_request_fields(&raw, &fallback) {
        Ok(fields) => serde_json::json!({
            "ok": true,
            "fields": { "base": fields.base, "title": fields.title, "body": fields.body, "draft": fields.draft }
        })
        .to_string(),
        Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
    }
}

/// Run one terminal quick-command helper by name over its JSON input, returning
/// JSON (TS `terminal-quick-commands.ts`). One entry covers normalize + the
/// typed-object accessors — see `orca_agents::terminal_quick_command_json`.
#[napi(catch_unwind)]
pub fn terminal_quick_command_op(function: String, input_json: String) -> String {
    let input = serde_json::from_str::<serde_json::Value>(&input_json).unwrap_or(serde_json::Value::Null);
    orca_agents::terminal_quick_command_json::dispatch(&function, &input).to_string()
}

/// Dispatch one TUI agent-startup plan builder by name over its camelCase JSON
/// (TS `tui-agent-startup.ts`). Covers buildAgentStartupPlan / …Resume… / …Draft…
/// — see `orca_agents::tui_agent_startup_json`. Returns `"null"` for a null plan.
#[napi(catch_unwind)]
pub fn tui_agent_startup_op(function: String, input_json: String) -> String {
    let input = serde_json::from_str::<serde_json::Value>(&input_json).unwrap_or(serde_json::Value::Null);
    orca_agents::tui_agent_startup_json::dispatch(&function, &input).to_string()
}

/// Build a `PullRequestDraftContext` from its camelCase JSON (string fields default
/// to "", `branch` nullable → `None`); shared by prompt-build + reply-parse.
fn parse_pull_request_context(context_json: &str) -> orca_agents::PullRequestDraftContext {
    let value = serde_json::from_str::<serde_json::Value>(context_json).unwrap_or(serde_json::Value::Null);
    let str_field = |key: &str| value.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let bool_field = |key: &str| value.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
    orca_agents::PullRequestDraftContext {
        branch: value.get("branch").and_then(|v| v.as_str()).map(str::to_string),
        base: str_field("base"),
        branch_changed_by_preparation: bool_field("branchChangedByPreparation"),
        current_title: str_field("currentTitle"),
        current_body: str_field("currentBody"),
        current_draft: bool_field("currentDraft"),
        commit_summary: str_field("commitSummary"),
        change_summary: str_field("changeSummary"),
        patch: str_field("patch"),
    }
}

/// Parse an OpenSSH config file into `SshConfigHost[]` JSON (the same shape TS
/// `parseSshConfig` returns). `home` is the `~`-expansion base the caller reads
/// from `os.homedir()` — kept explicit so the Rust core stays pure.
#[napi(catch_unwind)]
pub fn parse_ssh_config(content: String, home: String) -> String {
    let hosts = orca_ssh::parse_ssh_config(&content, &home);
    let array: Vec<serde_json::Value> = hosts.iter().map(ssh_config_host_to_json).collect();
    serde_json::Value::Array(array).to_string()
}

fn ssh_config_host_to_json(host: &orca_ssh::SshConfigHost) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("host".into(), serde_json::Value::from(host.host.clone()));
    if let Some(v) = &host.hostname {
        map.insert("hostname".into(), serde_json::Value::from(v.clone()));
    }
    if let Some(v) = host.port {
        map.insert("port".into(), serde_json::Value::from(v));
    }
    if let Some(v) = &host.user {
        map.insert("user".into(), serde_json::Value::from(v.clone()));
    }
    if let Some(v) = &host.identity_file {
        map.insert("identityFile".into(), serde_json::Value::from(v.clone()));
    }
    if let Some(v) = &host.identity_agent {
        map.insert("identityAgent".into(), serde_json::Value::from(v.clone()));
    }
    if let Some(v) = host.identities_only {
        map.insert("identitiesOnly".into(), serde_json::Value::from(v));
    }
    if let Some(v) = host.gssapi_authentication {
        map.insert("gssapiAuthentication".into(), serde_json::Value::from(v));
    }
    if let Some(v) = &host.proxy_command {
        map.insert("proxyCommand".into(), serde_json::Value::from(v.clone()));
    }
    if let Some(v) = host.proxy_use_fdpass {
        map.insert("proxyUseFdpass".into(), serde_json::Value::from(v));
    }
    if let Some(v) = &host.proxy_jump {
        map.insert("proxyJump".into(), serde_json::Value::from(v.clone()));
    }
    serde_json::Value::Object(map)
}

/// Validate raw session JSON as a `WorkspaceSessionState`, returning the TS
/// `ParsedWorkspaceSession` union (`{ok:true, value} | {ok:false, error}`) JSON.
/// Same parse/repair `src/main/persistence.ts` relied on the deleted shared zod
/// schema for — the Rust orca-config port is now the sole impl.
#[napi(catch_unwind)]
pub fn parse_workspace_session(raw_json: String) -> String {
    // JSON.stringify always yields valid JSON; Null models a non-object input,
    // which the parser rejects exactly as zod did.
    let raw: serde_json::Value = serde_json::from_str(&raw_json).unwrap_or(serde_json::Value::Null);
    match orca_config::parse_workspace_session(&raw) {
        orca_config::ParsedWorkspaceSession::Ok(value) => {
            serde_json::json!({ "ok": true, "value": value }).to_string()
        }
        orca_config::ParsedWorkspaceSession::Err(error) => {
            serde_json::json!({ "ok": false, "error": error }).to_string()
        }
    }
}

#[napi(catch_unwind)]
pub fn git_engine() -> &'static str {
    "orca-git"
}

/// Aggregate pure-module dispatch: the single napi entry every ported module
/// ships through (no per-module export). `input_json` empty → JSON null (a no-arg
/// call); input that does not parse is an `__dispatch_error__`, NOT a silent
/// no-arg call. Returns the module's JSON result, or an `__dispatch_error__`
/// object when no Rust dispatch is registered for `module`.
///
/// Body lives in `orca_dispatch::json_entry` so this and the wasm twin cannot
/// drift — one decode decision, two bindings.
#[napi(catch_unwind)]
pub fn orca_dispatch(module: String, function: String, input_json: String) -> String {
    orca_dispatch::dispatch_json(&module, &function, &input_json)
}

// --- orca-runtime: the multi-agent orchestration store, exposed as the stateful
// `OrchestrationStore` class the main-process TS OrchestrationDb shim delegates
// to (the node:sqlite twin was deleted). Its marshalling contract — JSON rows,
// positional arguments, and how store errors reach JS — is documented at the
// top of the module. ---
mod orchestration_store;

/// Result of feeding a chunk to [`NdjsonParser`]: the complete lines to JSON-parse
/// (in order) plus the observed byte sizes of any oversized lines that were dropped.
#[napi(object)]
pub struct NdjsonFeedResult {
    /// Complete lines (newline-stripped, non-empty) in arrival order.
    pub lines: Vec<String>,
    /// Byte sizes of dropped oversized lines (one per oversized report).
    pub oversized: Vec<u32>,
}

/// Stateful NDJSON byte-budget line splitter (orca_net::NdjsonSplitter) — the OOM
/// guard for the daemon socket. `feed` returns complete lines for the caller to
/// JSON.parse; oversized lines are dropped + the stream resyncs at the next newline.
#[napi(js_name = "NdjsonParser")]
pub struct JsNdjsonParser {
    inner: orca_net::NdjsonSplitter,
}

#[napi]
impl JsNdjsonParser {
    #[napi(constructor, catch_unwind)]
    pub fn new(max_line_bytes: Option<u32>) -> Self {
        let max = max_line_bytes
            .map(|n| n as usize)
            .unwrap_or(orca_net::NDJSON_MAX_LINE_BYTES);
        Self {
            inner: orca_net::NdjsonSplitter::new(max),
        }
    }

    #[napi(catch_unwind)]
    pub fn feed(&mut self, chunk: String) -> NdjsonFeedResult {
        let mut lines = Vec::new();
        let mut oversized = Vec::new();
        for event in self.inner.feed_collect(&chunk) {
            match event {
                orca_net::NdjsonEvent::Line(line) => lines.push(line),
                orca_net::NdjsonEvent::Oversized { observed_bytes } => {
                    oversized.push(u32::try_from(observed_bytes).unwrap_or(u32::MAX));
                }
            }
        }
        NdjsonFeedResult { lines, oversized }
    }

    #[napi(catch_unwind)]
    pub fn reset(&mut self) {
        self.inner.reset();
    }
}
