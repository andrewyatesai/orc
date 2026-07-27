// Logic moved to the Rust repo-icon core (orca-dispatch); this file retains types + data only.
// Main drives the Rust port via napi (src/main/rust-repo-icon.ts), the renderer
// via wasm (src/renderer/src/lib/git-wasm/repo-icon.ts).
// UNPORTED upstream v1.4.150 (rust/crates/orca-config/src/repo_icon.rs still
// hardcodes github.com + png): GHES avatar hosts, webp `file` src, and
// validateRasterImageDataUri magic-byte checks. Until it lands, `host` is dropped
// by the seams (src/main/rust-repo-icon.ts, renderer git-wasm/repo-icon.ts,
// orca-dispatch modules/repo_icon.rs) so the GHES icon-identity grouping that
// project-host-setup-projection.ts derives from repoIcon.src cannot occur.
export type RepoIconImageSource = 'upload' | 'file' | 'favicon' | 'github'

export type RepoIcon =
  | { type: 'lucide'; name: string }
  | { type: 'emoji'; emoji: string }
  | { type: 'image'; src: string; source: RepoIconImageSource; label?: string }

export const MAX_REPO_ICON_UPLOAD_BYTES = 256 * 1024
export const MAX_REPO_ICON_DATA_URL_LENGTH = 400 * 1024
