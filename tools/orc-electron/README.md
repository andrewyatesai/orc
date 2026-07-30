# orc-electron — the runtime fork (Campaign 3, green-lit 2026-07-15)

`orc-electron` is orc's maintained Electron fork: the "Own the Runtime" rung of the
extreme-performance moonshot (`docs/rust-migration/extreme-performance-moonshot.md` §7).
It is run as **standing agent ops** (patch-rebase waves, per-OS build verification,
gauntlet-gated), not a one-time event. This directory holds the fork's tooling,
patches, and the evidence gates that decide **which** fork work is actually warranted.

## Ladder (each rung entered on evidence — measure before rebuilding)

- **Rung 1 — flags on the stock binary.** SAB flags: ✅ landed (Wave 1). Flag sweep done.
- **Rung 2 — `orca://` + COOP/COEP → `crossOriginIsolated`.** The header path on the
  stock binary. Unlocks durable/growable SAB, high-res timers, **wasm threads**
  (+1.8–2.9× on parallelizable stages atop SIMD). **← the current high-value target.**
- **Rung 3 — the one justified electron-patch rebuild.** macOS low-latency canvas;
  pointer-compression-off whale variant; workload-PGO/BOLT.
- **Rung 4 — the fork.** origin-isolation, component stripping, custom V8 snapshot, etc.

## ⚑ Phase-0 kill-check finding — 2026-07-18 (`run-killcheck.mjs`)

**Verdict: `STOCK-RUNG-2-SUFFICES`** on Electron **43.1.0** (Chromium 150.0.7871.47).

Measured on the stock installed binary via a privileged `orc://` scheme serving
`COOP: same-origin` + `COEP: credentialless`:

| Signal | Result |
|---|---|
| `crossOriginIsolated` | **true** ✅ |
| durable/growable `SharedArrayBuffer` (`maxByteLength`+`grow`) | **true** ✅ |
| `<webview>` guest `did-attach` under COEP | **true** ✅ (identical with COEP on **and** off) |

**Consequence:** the fork's marquee **origin-isolation patch is NOT required on this pin.**
Its entire purpose was to delete a `<webview>`-cannot-attach-under-COEP kill-risk — and
that risk **does not reproduce**: the guest attaches under COEP exactly as it does
without it (the only difference vs COEP-off is that `crossOriginIsolated`/SAB become
available, which is the goal). So the durable-SAB + wasm-threads prize is reachable by
shipping **rung-2 in the real app**, with **no Chromium fork rebuild**.

Caveat (before deleting the patch from the plan): this is a scratch-harness guest. Confirm
the *real* app's `<webview>` guests (their actual content, partitions, and preload) load —
not just attach — under COEP, via the rung-2 kill-check `Phase-0` in-app. `did-finish-load`
did not fire in the offscreen harness for either COEP mode (a harness quirk, not COEP).

Re-run any time: `node tools/orc-electron/run-killcheck.mjs` (or `pnpm fork:killcheck`).
It re-derives the verdict; if a future Electron major flips it to `FORK-PATCH-JUSTIFIED`,
the origin-isolation patch re-enters scope.

**Status 2026-07-30 — rung-2 wiring SHIPPED + VALIDATED in-app; OPT-IN pending a
consumer.** The `orca://app` handler (`src/main/startup/renderer-scheme-request-handler.ts`)
serves `COOP: same-origin` + `COEP: credentialless` on documents, and `COEP:
credentialless` on script responses too — the spec has **no same-origin inheritance for
network-fetched dedicated workers** (only blob:/data: workers inherit), so the aterm
render worker's entry script must carry its own COEP or fail to load. The Phase-0
guest-LOAD caveat is CLOSED: with the headers on, the full browser-tab e2e suite passes
(6/6 — real `<webview>` guests load cross-origin HTTP content, retain form state,
handle new-tab gestures), the main window probes `crossOriginIsolated === true` on
`orca://app`, and durable+growable `SharedArrayBuffer` works. **Default is OFF**
(`ORCA_CROSS_ORIGIN_ISOLATION=1` enables, read once per handler install): the COOP
browsing-context-group swap measures ~35ms of window load (89→125ms A/B, medians n=6)
and nothing in the shipped renderer consumes isolation yet — the first real consumer
(aterm wasm threads) flips the default and nets the swap cost against its win.

## What the fork is still genuinely for (needs a real rebuild — Rung 3/4)

The kill-check retires the *origin-isolation* item, not the fork. These remain real and
are the actual justification for carrying `orc-electron`, in value order:

1. **macOS low-latency canvas** — carry the present-path patch Chromium never finished
   (1–2 compositor frames, 16–33ms @60Hz, off keystroke present on macOS).
2. **Component stripping + memory posture** — spellcheck/PDF/printing/translate out;
   PartitionAlloc tuning; pointer-compression-off whale variant as a first-class config.
3. **Custom V8 startup snapshot** with the app graph baked in.
4. **Routine per-major workload-PGO** (+1–4%) once profile collection is scripted.

`bootstrap-fork.sh` documents the checkout+build for when one of these is scheduled
(depot_tools + electron at the pinned tag + gclient sync + sccache). It is a
multi-hour, ~30–60GB operation — **kicked deliberately, gauntlet-gated, never blindly.**

## ⇒ The honest next runtime step: Rung-2 in-app serving (scoped 2026-07-18)

The kill-check proved the prize (durable SAB + wasm threads) is reachable on stock Electron 43 via
rung-2 — no fork rebuild. Turning that on in the REAL app is a bounded, gauntlet-testable change:

1. **Serve the renderer from a privileged `orca://` scheme instead of `file://`.** Today it loads via
   `loadFile` (e.g. `src/main/coordinator-window.ts:54`, the main window similarly). Add
   `protocol.registerSchemesAsPrivileged([{scheme:'orca', privileges:{standard,secure,supportFetchAPI,
   corsEnabled,stream,codeCache:true}}])` before app-ready and `protocol.handle('orca', …)` over
   `out/renderer`, then `loadURL('orca://app/index.html')`. Serve `.js`/`.wasm` with strict MIME.
2. **Fix the two `file://`-hardcoded sender-trust gates** — they currently reject any non-`file://`
   sender, so an `orca://` renderer would lose clipboard + browser IPC:
   - `src/main/window/clipboard-ipc-handlers.ts:245` — `senderUrl.startsWith('file://')`
   - `src/main/ipc/browser.ts:167` — `isTrustedBrowserRenderer` → `senderUrl.startsWith('file://')`
   Replace with an `isTrustedAppOrigin(senderUrl)` helper accepting the `orca://app` origin (keep
   `file://` during migration for the dev-server path / rollback).
3. **Then COOP:same-origin + COEP:credentialless on the `orca://` responses** → `crossOriginIsolated`
   → durable/growable SAB + high-res timers + **wasm threads** (+1.8–2.9× on parallelizable stages).
   ✅ wired + validated 2026-07-30, OPT-IN via `ORCA_CROSS_ORIGIN_ISOLATION=1`
   (see the status note above for the measured COOP swap cost and default rationale).
4. **In-app Phase-0 confirm** (the kill-check caveat): ✅ CLOSED 2026-07-30 — with the headers on,
   the browser-tab e2e suite passes 6/6 (real `<webview>` guests LOAD cross-origin HTTP content,
   retain form state, handle new-tab gestures), `crossOriginIsolated === true` probed in the live
   main window, durable+growable SAB verified. The origin-isolation fork patch stays retired.

Risk: invasive (serving + IPC trust). Gate every step on `pnpm gauntlet` + the existing e2e; ship
behind a flag; keep the `file://` path as rollback. This is product-surface work, not a fork rebuild.

## The treadmill (standing ops)

Electron carries ~248 patches; majors every 8 weeks; local release build ≈37min–1h49m
per OS×arch. The re-land cadence (patch-rebase, per-OS verify, bisect breakage) is exactly
what this repo delegates to agents gated by `pnpm gauntlet`. Budget it as ops, not an event.
