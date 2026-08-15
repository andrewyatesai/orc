// WSL UNC path types and data. The parsing was CUT OVER to the Rust
// `orca_core::wsl_paths` core — reach it through `wsl-unc-paths.ts`, which also
// rebuilds the deleted body from the pattern below for the surfaces that have
// not bound the dispatch seam.
export type WslUncPathInfo = {
  distro: string
  linuxPath: string
}

/** `//<share>/<distro>[/<tail>]` over the backslash-normalised path, matching
 *  `\\wsl.localhost\…` and the legacy `\\wsl$\…` share. Kept here as the data
 *  half of the parse so the seam shim's fallback rebuilds the twin's body rather
 *  than an approximation of it. The `.` in the tail is load-bearing — it
 *  excludes line terminators, which is the one place the Rust core disagrees
 *  (see `wsl-unc-paths.ts`). */
export const WSL_UNC_PATH_PATTERN = /^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i
