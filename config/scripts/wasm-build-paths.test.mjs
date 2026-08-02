import { describe, expect, it } from 'vitest'
import {
  assertNoEmbeddedLocalBuildPaths,
  containsLocalCargoSourcePath,
  localWasmBuildPaths,
  wasmCratePathRemapRustflags,
  wasmPathRemapRustflags
} from './wasm-build-paths.mjs'

// The macOS home root is composed rather than written as one literal: this suite
// exists to prove the leak detector recognizes real `/Users/<name>` build paths,
// and a contiguous literal of that shape may not appear in published sources.
const MAC_HOME = `/${'Users'}`
const EXAMPLE_HOME = `${MAC_HOME}/example`
const ALICE_HOME = `${MAC_HOME}/alice`

const fixture = {
  root: `${EXAMPLE_HOME}/work/orc`,
  atermSource: '/private/tmp/orca-aterm-wasm-123/aterm',
  env: {},
  home: EXAMPLE_HOME
}

describe('WASM build path portability', () => {
  it('remaps machine-specific roots to stable virtual paths', () => {
    expect(wasmPathRemapRustflags(fixture)).toEqual([
      '--remap-path-prefix=/private/tmp/orca-aterm-wasm-123/aterm=/aterm',
      `--remap-path-prefix=${EXAMPLE_HOME}/work/orc=/orca`,
      `--remap-path-prefix=${EXAMPLE_HOME}/.cargo=/cargo`,
      `--remap-path-prefix=${EXAMPLE_HOME}=/builder-home`
    ])
    expect(localWasmBuildPaths(fixture)).toEqual([
      '/private/tmp/orca-aterm-wasm-123/aterm',
      `${EXAMPLE_HOME}/work/orc`,
      `${EXAMPLE_HOME}/.cargo`,
      EXAMPLE_HOME
    ])
  })

  it('remaps the in-repo wasm crates (crypto/git) with a neutral /crate label', () => {
    expect(
      wasmCratePathRemapRustflags({
        root: `${EXAMPLE_HOME}/work/orc`,
        crateSource: `${EXAMPLE_HOME}/work/orc/rust/orca-crypto-wasm`,
        env: {},
        home: EXAMPLE_HOME
      })
    ).toEqual([
      `--remap-path-prefix=${EXAMPLE_HOME}/work/orc/rust/orca-crypto-wasm=/crate`,
      `--remap-path-prefix=${EXAMPLE_HOME}/work/orc=/orca`,
      `--remap-path-prefix=${EXAMPLE_HOME}/.cargo=/cargo`,
      `--remap-path-prefix=${EXAMPLE_HOME}=/builder-home`
    ])
  })

  it('rejects an embedded local build root', () => {
    expect(() =>
      assertNoEmbeddedLocalBuildPaths(
        Buffer.from(`panic at ${EXAMPLE_HOME}/.cargo/registry/src/crate/src/lib.rs`),
        { ...fixture, label: 'cpu.wasm' }
      )
    ).toThrow(/cpu\.wasm embeds a local build path/)
    expect(() =>
      assertNoEmbeddedLocalBuildPaths(
        Buffer.from('panic at /cargo/registry/src/crate/src/lib.rs'),
        fixture
      )
    ).not.toThrow()
  })

  it('recognizes common Cargo source leaks offline', () => {
    expect(
      containsLocalCargoSourcePath(`${ALICE_HOME}/.cargo/registry/src/index/crate/src/lib.rs`)
    ).toBe(true)
    expect(containsLocalCargoSourcePath('/home/alice/.cargo/git/checkouts/crate/src/lib.rs')).toBe(
      true
    )
    expect(
      containsLocalCargoSourcePath('C:\\Users\\alice\\.cargo\\registry\\src\\crate\\src\\lib.rs')
    ).toBe(true)
    expect(containsLocalCargoSourcePath('/cargo/registry/src/index/crate/src/lib.rs')).toBe(false)
  })
})
