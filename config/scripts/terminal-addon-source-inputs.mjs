// Freshness inputs for the orca_node.node rebuild-skip probe: every local
// source the addon binary is compiled from. Under-listing a crate here is the
// stale-addon bug class — the probe reports "up to date", `pnpm test` runs
// vitest against a binary missing a newer napi surface, and a suite like
// mutation-receipts.test.ts fails 5/5 with "not a function".

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Probed roots: the addon crate itself plus EVERY rust/crates/* crate.
 *  All-of-rust/crates over-approximates the link set on purpose — the addon's
 *  Cargo.toml path deps pull workspace-internal transitives, and a missed crate
 *  silently disables the rebuild. rust/aterm is covered separately by the
 *  source stamp (terminal-addon-source-stamp.mjs). */
export function terminalAddonSourceInputRoots({ addonDir, projectDir }) {
  const roots = [
    resolve(addonDir, 'src'),
    resolve(addonDir, 'Cargo.toml'),
    resolve(addonDir, 'Cargo.lock'),
    resolve(addonDir, 'build.rs'),
    // The linked crates inherit workspace fields from this manifest.
    resolve(projectDir, 'rust/Cargo.toml')
  ]
  const cratesDir = resolve(projectDir, 'rust/crates')
  if (existsSync(cratesDir)) {
    for (const crate of readdirSync(cratesDir)) {
      roots.push(
        join(cratesDir, crate, 'src'),
        join(cratesDir, crate, 'Cargo.toml'),
        join(cratesDir, crate, 'build.rs')
      )
    }
  }
  return roots
}

/** Newest mtime among all probed roots — the value an installed addon's own
 *  mtime must beat for the rebuild to be skippable. */
export function newestTerminalAddonSourceMtime({ addonDir, projectDir }) {
  let newest = 0
  const walk = (p) => {
    if (!existsSync(p)) {
      return
    }
    const st = statSync(p)
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) {
        walk(join(p, e))
      }
    } else {
      newest = Math.max(newest, st.mtimeMs)
    }
  }
  for (const root of terminalAddonSourceInputRoots({ addonDir, projectDir })) {
    walk(root)
  }
  return newest
}
