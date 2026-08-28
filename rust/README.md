# Orca native Rust workspace

The cross-platform Rust core of the native Orca rewrite. The layout, build/test
commands, and the porting invariant are below; the architecture, functional and
dependency maps, migration plan, and ported-modules ledger live in the internal
`docs/rust-migration/` notes, which are not part of the public source snapshot.

## Layout

```
rust/
├── Cargo.toml            # workspace (release profile: opt-level=z, LTO, strip)
├── aterm/                # terminal engine submodule, consumed by orca-terminal
└── crates/               # 27 crates, all building today
    └── orca-core/        # pure cross-cutting logic ported from src/shared (no IO)
```

All 27 crates now exist and build: the pure/config tiers (`orca-core`, `orca-text`,
`orca-config`, `orca-agents`, `orca-policy`), the IO tiers (`orca-git`, `orca-pty`,
`orca-ssh`, `orca-net`, `orca-store`, `orca-crypto`, `orca-relay`, `orca-runtime`,
`orca-winpipe`), the terminal stack (`orca-terminal`, `orca-session`, `orca-session-gc`,
`orca-ffi`, `orca-aterm-demo`, `orca-flow-control`, `orca-stream-split`,
`orca-renderer-heap`), the resilience tier (`orca-crash-recovery`, `orca-dispatch`,
`orca-provider-backoff`), and the native `orca-daemon` binary with its `orca-parity`
harness. `cargo test` passes for the buildable set (`pnpm test:rust` from the repo
root). The terminal engine lives in the `aterm` submodule (`rust/aterm`) and is
consumed by `orca-terminal`.

**The engine pin is a commit, not a version string.** aterm's version line was
restarted, and the version values reachable from this tree disagree with one another,
so no number here would be trustworthy. The authoritative pin is `sourceCommit` in
`src/renderer/src/lib/pane-manager/aterm/aterm_wasm_artifact_pin.json`, enforced
offline by `pnpm check:aterm-pin`, which requires `[workspace.package] version` in
`rust/aterm/Cargo.toml` to match the `aterm(x.y.z)` marker embedded in each committed
WASM blob.

## Build & test

```sh
cargo test  --manifest-path crates/orca-core/Cargo.toml   # behavioural parity vs the TS tests
cargo clippy --manifest-path crates/orca-core/Cargo.toml --all-targets
cargo build --release                                     # stripped, LTO'd
```

On a machine without the Trust toolchain, run the workspace suite via
`pnpm run test:rust` (config/scripts/run-rust-tests.mjs). `.cargo/config.toml`
injects Trust-only `-Z` flags into **both** `rustflags` and `rustdocflags`, so a
bare `cargo +stable test --workspace` is red out of the box — and clearing
`RUSTFLAGS` alone still fails at the doc-test phase. The script pins rustup
`stable` and clears both, keeping the stable lane green end to end (doctests
included); the Trust lane keeps building and doc-testing verified.

`orca-core` is zero-dependency, `#![forbid(unsafe_code)]`, and written
panic-free so it can be verified with **Trust** ("trusted Rust") once a stage2
sysroot is built:

```sh
# from a Trust stage2 sysroot (see ~/trust):
tcargo trust check --format json --manifest-path crates/orca-core/Cargo.toml
```

## Porting invariant

Every module is a faithful port of its `src/shared/*` source **with the original
test cases translated verbatim**, so `cargo test` is the parity gate. See the
ledger for what's done and what's next.
