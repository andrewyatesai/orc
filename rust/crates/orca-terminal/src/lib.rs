//! `orca-terminal` — headless terminal emulation for Orca.
//!
//! The native replacement for the `@xterm/headless`-based
//! `src/main/daemon/headless-emulator.ts`: maintains a server-side grid +
//! cursor and tracks the working directory via OSC-7, so terminal sessions
//! survive reconnect / SSH replay. A thin adapter over the `aterm` engine,
//! which owns the VT parser, grid, scrollback, and SGR/colour model.

pub mod color_scheme_protocol;
pub mod headless;
pub mod inline_images;
pub mod key_encoding;
pub mod scrollback_search;
pub mod styled_frame;

pub use color_scheme_protocol::{
    mode_2031_sequence_for, resolve_terminal_color_scheme_mode, scan_mode_2031_sequences,
    Mode2031ScanResult, TerminalColorSchemeMode,
};
pub use headless::{
    Cell, CellAttrs, Color, HeadlessTerminal, MouseTracking, TerminalSnapshot, DEFAULT_SCROLLBACK,
};
pub use inline_images::{
    InlineImageEncoding, InlineImagePayload, InlineImagePlacement, InlineImageReadOptions,
};
pub use key_encoding::KeyEncoding;
pub use scrollback_search::{replay_for_search, MatchSummary, SearchOptions, SearchOutcome};
pub use styled_frame::{
    ScreenCursor, ScreenDetail, ScreenModes, StyleRun, StyledFrame, StyledFrameOptions, StyledRow,
    SCREEN_ATTR_CODES,
};
