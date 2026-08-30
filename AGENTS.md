*`docs/` holds internal design notes and is not part of the public source snapshot, so paths under it appear below as plain paths, never as links; each rule states its constraint inline.*

# Design System

All UI work — layout, color, typography, spacing, component selection, UX behavior — must follow the design system recorded in `docs/STYLEGUIDE.md`. Use the tokens defined in `src/renderer/src/assets/main.css` (the canonical source, and the one that ships) and the shadcn primitives in `src/renderer/src/components/ui/`. Don't invent new color values, font sizes, or shadow tiers when a documented one already covers the role. When STYLEGUIDE.md is silent, follow the resolution order in its final section.

# Style
## Concise/Brief Non-obviosu comments ONLY
  * DO NOT: be verbose, explain the obvious, walk through the code ("WHY not HOW")
  * DO: BE CONCISE. 1 LINE if possible

## Lint Rules: Do Not Disable Max Lines

NEVER add a `max-lines` disable (`eslint-disable max-lines`, `oxlint-disable max-lines`, or line-specific variants), and never add a per-file `max-lines` bump in `mobile/.oxlintrc.json`.

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero info and tend to become dumping grounds. Name files after what they _actually_ contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Tests Must Prove Reachability

A test that constructs its own inputs proves the logic, never that production reaches it. When a capability has to work in the shipped app, exercise the production construction path — the registered IPC handler, the real dispatcher, the gate's own CLI — not a hand-built double. Every guard needs a test that plants a violation and watches it fail; a test you have never seen fail proves nothing.

## Type Declarations: Prefer `.ts` Over `.d.ts`

# Considerations
## Trust Toolchain Posture (measured 2026-08-30)

State this accurately; do not describe the aspiration as the posture.

- `rust-toolchain.toml` pins channel `trust`, so a bare `cargo` here resolves to the sealed Trust toolchain.
- Two config tables carry identical flags and must stay in lockstep: `.cargo/config.toml` (read by invocations that start at the repo root) and `rust/.cargo/config.toml` (read from `rust/`). First-party **target** units verify at `-Ztrust-policy=advisory` with `-Ztrust-verify-function-budget-ms=5000`; `[host]` units (build scripts, proc-macros) and `rustdocflags` carry `-Ztrust-verify=off`, gated by `target-applies-to-host = false`. That host/target split is the sanctioned pattern — keep it.
- **There is no blanket first-party off-switch, and adding one is not an option.** Two gaps are open and should be named as gaps: (1) vendored third-party units share the first-party policy, because cargo has no per-package rustflags — per-unit scoping is the fix; (2) every routine script (`build-rust-daemon`, `build-terminal-addon`, the three WASM builders, `run-parity`, `run-rust-tests`) selects rustup `stable` explicitly, so the **shipped artifacts are unverified builds** (`build-terminal-addon` is the one with an opt-in, `ORCA_RUST_TOOLCHAIN=trust`). Trust runs only in `pnpm verify:rust`, which reports and never gates.
- Advisory is verified-and-reported, never verified-clean. A timed-out or unsupported obligation is an assumption, not a proof.
- Flag spellings are a property of the installed toolchain, not of the calendar. `config/scripts/check-trust-flag-surface.mjs` (wired into `pnpm lint`) probes both tables against `rustc -Z help`. Never answer a flag rejection by clearing `RUSTFLAGS` or building from a directory where the table is not read — both compile vanilla Rust silently.

## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## Cross-Platform Support

Orca targets macOS, Linux, and Windows. Keep all platform-dependent behavior behind runtime checks:

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. Use a platform check (`navigator.userAgent.includes('Mac')`) to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows. Electron menu accelerators should use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` on other platforms.
- **File paths**: Use `path.join` or Electron/Node path utilities — never assume `/` or `\`.
- **Linux native modules**: keep the glibc floor at Ubuntu 20.04 / glibc 2.31 (libstdc++ `GLIBCXX_3.4.28`). A module compiled from source on a newer runner can reference symbol versions absent on the floor — glibc's 2.32–2.34 libpthread/libutil merge relocated `pthread_sigmask`, `openpty`, and `forkpty` — and the app then crashes at startup before a window appears. node-pty is pinned back to the pre-merge symbol versions by [`config/patches/node-pty@1.1.0.patch`](./config/patches/node-pty@1.1.0.patch), and [`config/scripts/verify-linux-glibc-floor.cjs`](./config/scripts/verify-linux-glibc-floor.cjs) runs in electron-builder's `afterPack` hook and fails packaging if any bundled native binary needs newer glibc. Full background: `docs/reference/linux-glibc-compatibility.md`.

## SSH Use Case

All changes must consider the SSH use case. Don't assume local-only execution.

## Folder Workspace Use Case

All changes must consider folder workspaces as well as git worktrees. Don't assume every workspace is a git worktree.

## Git Binary Compatibility

Orca runs the user's Git binary on native, WSL, and SSH hosts, which may all have different versions. Treat Git 2.25 as the core-workflow baseline — the oldest line that covers porcelain v2, `branch --show-current`, `restore`, and sparse checkout. The rules below are the contract; the per-command version boundaries are recorded in `docs/reference/git-compatibility.md`.

When adding or changing a Git command:

- Check when every subcommand and option was introduced. For newer behavior, keep a baseline-compatible fallback or degrade safely.
- Use `GitCapabilityCache` with a narrow unsupported-error predicate so recurring operations do not retry a known-invalid command. Do not rely only on `git --version`; wrappers such as `simple-git` do not remove host-version differences.
- Scope capability state to the host that executes Git: native, WSL distro, SSH provider, or relay connection. Cover the first fallback, later cached calls, concurrent probes, and relevant host isolation in tests.
- Keep the real-binary compatibility contract current: `src/shared/git-binary-compatibility.test.ts`, driven locally via `ORCA_GIT_COMPAT_BINARY`/`ORCA_GIT_COMPAT_IMAGE` (this repo runs no hosted CI — local gates are the gate). When adopting a newer Git feature, add its version boundary so the preferred command and fallback both run against representative Git releases.
- Preserve commands that begin with global Git options such as `-c` before the subcommand, including auto-maintenance suppression used by worktree-create fetches.

## Git Provider Compatibility

Source-control and review changes must consider GitLab and other supported git providers, not only GitHub. Keep provider-specific behavior behind explicit checks, and avoid GitHub-only naming for generic review concepts.

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.
