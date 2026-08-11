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
└── crates/               # 18 crates, all building today
    └── orca-core/        # pure cross-cutting logic ported from src/shared (no IO)
```

All 18 crates now exist and build: the pure/config tiers (`orca-core`, `orca-text`,
`orca-config`, `orca-agents`), the IO tiers (`orca-git`, `orca-pty`, `orca-ssh`,
`orca-net`, `orca-store`, `orca-crypto`, `orca-relay`, `orca-runtime`), the terminal
stack (`orca-terminal`, `orca-session`, `orca-ffi`, `orca-aterm-demo`), and the native
`orca-daemon` binary with its `orca-parity` harness. `cargo test` passes for the
buildable set. The terminal engine lives in the `aterm` submodule (`rust/aterm`,
pinned to `v0.18.2607040011`) and is consumed by `orca-terminal`.

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
