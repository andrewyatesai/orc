//! Structured access to the inline images a pane emitted — the engine side of
//! `terminal.images` (docs/reference/alab-agent-visibility.md §6).
//!
//! The engine already parses and RETAINS these: iTerm2 OSC 1337 `File=` is
//! compiled unconditionally, sixel is on in every Orca seam, and Kitty Unicode
//! placeholders are synthesized into the same `ImageRef` shape. The payload is
//! held once behind an `Arc<ImageData>` and every covered cell points at it with
//! its own tile coordinates. Nothing was missing but an accessor.
//!
//! Two properties of that storage drive this module's shape:
//!
//! * **One image is many cells.** A placement covers `rows x cols` cells, each
//!   holding an `ImageRef` into the same `Arc`. Reporting one entry per covered
//!   cell would hand a caller a thousand copies of one picture, so placements
//!   are coalesced by (payload identity, origin) — the same `Arc` drawn twice on
//!   screen is correctly two placements.
//! * **The bytes are the program's own.** No re-render, no rasterization: what
//!   comes back is what the emitting program wrote. That also means a single
//!   placement can be megabytes, which is why the default read is metadata-only
//!   and byte requests are budgeted.
//!
//! Scope is the VISIBLE grid, and that is a hard boundary, not an oversight:
//! `set_scrollback_text_only(true)` (see `headless.rs`) routes scrolled-off rows
//! through a converter that keeps hyperlink spans and DROPS image refs. An image
//! that scrolled away is gone from this seam entirely. Callers must report that
//! blind spot rather than let an empty list read as "this pane emitted none".

use std::collections::HashMap;
use std::sync::Arc;

use aterm_grid::{ImageData, ImageFormat};

use crate::headless::HeadlessTerminal;

/// Source encoding of a retained payload, as the engine recorded it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InlineImageEncoding {
    /// A PNG file, verbatim.
    Png,
    /// Already-decoded packed RGBA8 (4 bytes per pixel, row-major over `width`).
    /// The sixel path lands here: sixel has no container, so `aterm-sixel`
    /// decodes the raster in-engine and stores pixels.
    Rgba8 { width: u16, height: u16 },
    /// Kept verbatim, format not identified (JPEG, GIF, …). Reported as unknown
    /// rather than guessed — a caller sniffing the bytes is better placed to
    /// decide than this layer is.
    Unknown,
}

/// What happened to one placement's bytes on this read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InlineImagePayload {
    /// Metadata-only read — the default, and not a failure.
    NotRequested,
    /// Bigger than the per-image cap. Withheld WHOLE rather than truncated: a
    /// prefix of a PNG is not a smaller PNG, it is a corrupt one, and handing
    /// back something that fails to decode is worse than saying "too big".
    TooLarge,
    /// Earlier placements on this same read spent the total budget.
    BudgetExhausted,
    /// Standard base64 of the exact bytes the program emitted.
    Base64(String),
}

/// One inline image placed on the visible grid.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineImagePlacement {
    /// Top row of the covered bounding box, in visible-grid coordinates.
    pub row: usize,
    /// Left column of the covered bounding box.
    pub col: usize,
    /// Full footprint height in cells, as placed — may exceed what is on screen.
    pub cell_rows: u16,
    /// Full footprint width in cells, as placed.
    pub cell_cols: u16,
    /// Cells of that footprint actually on the visible grid right now. Less than
    /// `cell_rows * cell_cols` means the placement is clipped or partly scrolled
    /// off; the retrievable bytes are still the whole image.
    pub covered_cells: usize,
    pub encoding: InlineImageEncoding,
    /// Size of the retained payload, whether or not it was returned.
    pub byte_len: usize,
    /// Kitty `z=` stacking: negative draws behind the cell's text.
    pub z_index: i32,
    /// FNV-1a 64 over the payload. An identity hint so a caller polling a pane
    /// can tell "same picture as last time" without moving the bytes — NOT a
    /// checksum and not collision-proof.
    pub fingerprint: u64,
    pub payload: InlineImagePayload,
}

/// Byte budget for one read. The caller owns the numbers (Orca clamps them at
/// the RPC edge, where the limits are documented and tested); this layer applies
/// exactly what it is given. `Default` is the metadata-only read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InlineImageReadOptions {
    pub include_bytes: bool,
    /// Placements larger than this are reported as [`InlineImagePayload::TooLarge`].
    pub max_bytes_per_image: usize,
    /// Ceiling on the bytes returned across all placements in one read.
    pub max_total_bytes: usize,
}

/// Accumulator for the cells of one placement while the grid scan runs.
struct PlacementScan {
    image: Arc<ImageData>,
    row: usize,
    col: usize,
    covered_cells: usize,
}

impl HeadlessTerminal {
    /// Inline images currently on the visible grid, in reading order.
    ///
    /// Empty means "none on screen NOW" — never "this pane emitted none". The
    /// engine drops image refs when a row scrolls off, so the caller must pair
    /// this with the retained-history depth to say which one it is.
    pub fn inline_images(&self, opts: InlineImageReadOptions) -> Vec<InlineImagePlacement> {
        let (rows, _) = self.size();
        let mut scans: HashMap<(usize, isize, isize), PlacementScan> = HashMap::new();
        for row in 0..rows {
            for (col, cell) in self.engine().images_row(row) {
                // Origin, not the covered cell: every cell of one placement must
                // fold into ONE entry, and the tile coordinates say where this
                // cell sits inside the footprint. Keyed by payload identity too,
                // so the same image drawn in two places stays two placements.
                let origin_row = row as isize - cell.cell_row as isize;
                let origin_col = col as isize - cell.cell_col as isize;
                let key = (Arc::as_ptr(&cell.image) as usize, origin_row, origin_col);
                let scan = scans.entry(key).or_insert_with(|| PlacementScan {
                    image: Arc::clone(&cell.image),
                    row,
                    col,
                    covered_cells: 0,
                });
                scan.row = scan.row.min(row);
                scan.col = scan.col.min(col);
                scan.covered_cells += 1;
            }
        }

        let mut scans: Vec<PlacementScan> = scans.into_values().collect();
        // Reading order, with the payload as a tiebreak so two images stacked on
        // one cell come back in a stable order across calls.
        scans.sort_by(|a, b| {
            (a.row, a.col, a.image.z_index, a.image.bytes.len()).cmp(&(
                b.row,
                b.col,
                b.image.z_index,
                b.image.bytes.len(),
            ))
        });

        let mut spent = 0usize;
        scans
            .into_iter()
            .map(|scan| {
                let bytes = &scan.image.bytes;
                let payload = if !opts.include_bytes {
                    InlineImagePayload::NotRequested
                } else if bytes.len() > opts.max_bytes_per_image {
                    InlineImagePayload::TooLarge
                } else if spent + bytes.len() > opts.max_total_bytes {
                    InlineImagePayload::BudgetExhausted
                } else {
                    spent += bytes.len();
                    InlineImagePayload::Base64(encode_base64(bytes))
                };
                InlineImagePlacement {
                    row: scan.row,
                    col: scan.col,
                    cell_rows: scan.image.rows,
                    cell_cols: scan.image.cols,
                    covered_cells: scan.covered_cells,
                    encoding: match scan.image.format {
                        ImageFormat::Png => InlineImageEncoding::Png,
                        ImageFormat::RawRgba8 { width, height } => {
                            InlineImageEncoding::Rgba8 { width, height }
                        }
                        ImageFormat::Unknown => InlineImageEncoding::Unknown,
                    },
                    byte_len: bytes.len(),
                    z_index: scan.image.z_index,
                    fingerprint: fnv1a64(bytes),
                    payload,
                }
            })
            .collect()
    }
}

/// FNV-1a 64. Chosen over a real digest because this crate carries no hashing
/// dependency and the value is only ever compared for equality against another
/// read of the same pane.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding — the form `Buffer.from(s, 'base64')` reads.
fn encode_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map_or(0, u32::from);
        let b2 = chunk.get(2).copied().map_or(0, u32::from);
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(BASE64_ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            BASE64_ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BYTES: InlineImageReadOptions = InlineImageReadOptions {
        include_bytes: true,
        max_bytes_per_image: 1 << 20,
        max_total_bytes: 1 << 20,
    };

    /// A 1x1 red PNG — a real file, so the format detection is exercised, not mocked.
    const RED_DOT_PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn osc_1337(base64: &str, width: u32, height: u32) -> String {
        format!("\x1b]1337;File=inline=1;width={width};height={height}:{base64}\x07")
    }

    #[test]
    fn base64_round_trips_through_the_standard_alphabet() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foob"), "Zm9vYg==");
        assert_eq!(encode_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(encode_base64(&[0xff, 0xfe, 0xfd]), "//79");
    }

    #[test]
    fn a_pane_with_no_images_reports_none() {
        let mut term = HeadlessTerminal::new(10, 40);
        term.process_str("plain text\r\n");
        assert!(term.inline_images(BYTES).is_empty());
    }

    #[test]
    fn one_osc_1337_image_is_one_placement_not_one_per_cell() {
        let mut term = HeadlessTerminal::new(10, 40);
        term.process_str(&osc_1337(RED_DOT_PNG_BASE64, 4, 2));
        let images = term.inline_images(InlineImageReadOptions::default());
        assert_eq!(images.len(), 1, "a 4x2 footprint must coalesce to one entry");
        let image = &images[0];
        assert_eq!((image.row, image.col), (0, 0));
        assert_eq!((image.cell_rows, image.cell_cols), (2, 4));
        assert_eq!(image.covered_cells, 8);
        assert_eq!(image.encoding, InlineImageEncoding::Png);
        assert_eq!(image.payload, InlineImagePayload::NotRequested);
        assert!(image.byte_len > 0, "the payload is retained even on a metadata read");
    }

    #[test]
    fn requested_bytes_are_the_exact_payload_the_program_emitted() {
        let mut term = HeadlessTerminal::new(10, 40);
        term.process_str(&osc_1337(RED_DOT_PNG_BASE64, 2, 1));
        let images = term.inline_images(BYTES);
        let InlineImagePayload::Base64(ref encoded) = images[0].payload else {
            panic!("expected bytes, got {:?}", images[0].payload);
        };
        assert_eq!(encoded, RED_DOT_PNG_BASE64, "no re-encode: the emitted bytes come back");
    }

    #[test]
    fn an_oversized_payload_is_withheld_whole_rather_than_truncated() {
        let mut term = HeadlessTerminal::new(10, 40);
        term.process_str(&osc_1337(RED_DOT_PNG_BASE64, 2, 1));
        let images = term.inline_images(InlineImageReadOptions {
            include_bytes: true,
            max_bytes_per_image: 4,
            max_total_bytes: 1 << 20,
        });
        assert_eq!(images[0].payload, InlineImagePayload::TooLarge);
        assert!(images[0].byte_len > 4, "the true size is still reported");
    }

    #[test]
    fn the_total_budget_stops_at_the_placement_that_would_exceed_it() {
        let mut term = HeadlessTerminal::new(10, 40);
        term.process_str(&osc_1337(RED_DOT_PNG_BASE64, 2, 1));
        term.process_str("\r\n\r\n");
        term.process_str(&osc_1337(RED_DOT_PNG_BASE64, 2, 1));
        let images = term.inline_images(InlineImageReadOptions {
            include_bytes: true,
            max_bytes_per_image: 1 << 20,
            max_total_bytes: 80,
        });
        assert_eq!(images.len(), 2);
        assert!(matches!(images[0].payload, InlineImagePayload::Base64(_)));
        assert_eq!(images[1].payload, InlineImagePayload::BudgetExhausted);
    }

    #[test]
    fn the_same_image_drawn_twice_is_two_placements_in_reading_order() {
        let mut term = HeadlessTerminal::new(10, 40);
        term.process_str(&osc_1337(RED_DOT_PNG_BASE64, 2, 1));
        term.process_str("\r\n\r\n");
        term.process_str(&osc_1337(RED_DOT_PNG_BASE64, 2, 1));
        let images = term.inline_images(InlineImageReadOptions::default());
        assert_eq!(images.len(), 2);
        assert!(images[0].row < images[1].row);
        assert_eq!(images[0].fingerprint, images[1].fingerprint, "identical bytes, one identity");
    }

    #[test]
    fn scrolling_an_image_off_loses_it_the_blind_spot_this_layer_cannot_close() {
        let mut term = HeadlessTerminal::new(4, 40);
        term.process_str(&osc_1337(RED_DOT_PNG_BASE64, 2, 1));
        assert_eq!(term.inline_images(InlineImageReadOptions::default()).len(), 1);
        for _ in 0..12 {
            term.process_str("\r\nfiller\r\n");
        }
        assert!(
            term.inline_images(InlineImageReadOptions::default()).is_empty(),
            "images do not survive scroll-off; callers must declare that, not hide it"
        );
        assert!(term.scrollback_len() > 0, "the rows themselves are still retained as text");
    }

    #[test]
    fn a_sixel_raster_reports_its_decoded_pixel_dimensions() {
        let mut term = HeadlessTerminal::new(10, 40);
        // Two sixel bands of one color: `#0;2;100;0;0` defines RGB, `~` sets all
        // six pixels of a column.
        term.process_str("\x1bP0;0;0q#0;2;100;0;0#0~~~~\x1b\\");
        let images = term.inline_images(InlineImageReadOptions::default());
        assert_eq!(images.len(), 1, "sixel reaches the same retained-image path");
        let InlineImageEncoding::Rgba8 { width, height } = images[0].encoding else {
            panic!("sixel decodes in-engine to RGBA8, got {:?}", images[0].encoding);
        };
        assert_eq!((width, height), (4, 6));
        assert_eq!(images[0].byte_len, 4 * 4 * 6, "packed RGBA8 is 4 bytes per pixel");
    }
}
