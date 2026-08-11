#!/usr/bin/env node

// Stable-lane test entrypoint for the rust/ workspace (`pnpm run test:rust`).
//
// rust/.cargo/config.toml compiles the workspace WITH Trust verification on by
// injecting `-Ztrust-verify=*` flags into BOTH `rustflags` and `rustdocflags`.
// Stock stable rustc/rustdoc refuse those flags, so a bare
// `cargo +stable test --workspace` exits before running a single test — and
// clearing RUSTFLAGS alone (the build-rust-daemon.mjs idiom) still leaves the
// doc-test phase red, because doctests read `rustdocflags`, which a RUSTFLAGS
// override does not touch. Clear BOTH, matching
// tools/terminal-bench/gauntlet-certificates.mjs: the stable lane asks whether
// the code passes its tests, which is a question about the code, not the
// verifier. The Trust lane still builds and runs doctests verified via the
// config table.
//
// Toolchain: pin BOTH cargo and rustc to the rustup `stable` toolchain — the
// machine default can be a Homebrew shadow or the (possibly mid-rebuild) Trust
// toolchain, matching build-rust-daemon.mjs. Fully offline: the workspace
// resolves against rust/vendor.
//
// Extra CLI args pass straight through to `cargo test`, so
// `pnpm run test:rust -- -p orca-core` narrows the run.

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { CargoCommandFailure, runStreamedCargoCommand } from './stream-cargo-command.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const manifest = resolve(projectDir, 'rust/Cargo.toml')
const rustWorkspaceDir = dirname(manifest)

function rustupBin(tool) {
  const r = spawnSync('rustup', ['which', tool, '--toolchain', 'stable'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

const cargoBin = rustupBin('cargo')
const rustcBin = rustupBin('rustc')
// Doctests spawn `rustdoc`, which cargo resolves from PATH — on a machine whose
// rustup default is another toolchain, an unpinned rustdoc mixes with
// stable-built deps and dies with E0514 (incompatible rustc metadata). Pin it
// like rustc.
const rustdocBin = rustupBin('rustdoc')
if (!cargoBin || !rustcBin || !rustdocBin) {
  console.error(
    '[test-rust] rustup `stable` toolchain unavailable (the workspace needs rustc 1.96). ' +
      'Install it with `rustup toolchain install stable`.'
  )
  process.exitCode = 1
}

async function main() {
  console.log('[test-rust] cargo test --workspace (rustup stable, offline via rust/vendor)')
  // Run inside rust/ so cargo discovers .cargo/config.toml and the checked-in
  // offline vendor source is actually used; the env below overrides only the
  // Trust-only flag tables (caller-supplied values still win).
  await runStreamedCargoCommand({
    command: cargoBin,
    args: [
      'test',
      '--workspace',
      '--manifest-path',
      manifest,
      '--offline',
      ...process.argv.slice(2)
    ],
    cwd: rustWorkspaceDir,
    env: {
      ...process.env,
      RUSTC: rustcBin,
      RUSTDOC: rustdocBin,
      RUSTFLAGS: process.env.RUSTFLAGS ?? '',
      RUSTDOCFLAGS: process.env.RUSTDOCFLAGS ?? ''
    },
    label: 'test-rust'
  })
}

if (cargoBin && rustcBin && rustdocBin) {
  try {
    await main()
  } catch (error) {
    if (!(error instanceof CargoCommandFailure)) {
      throw error
    }
    console.error(`[test-rust] ${error.message}`)
    process.exitCode = error.exitCode
  }
}
