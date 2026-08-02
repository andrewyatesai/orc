<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cold-start serialization leads — external design review (codex, 2026-08-01)

Three serializations on the path to a usable terminal, reviewed by codex-cli
independently of the agent that found them. Captured because the implementation
attempt was cut short by a usage limit, and because a PRIOR attempt at these
same three was reverted for breaking the rules restated below.

Measured context: time-to-first-terminal ~900ms-1s; the remaining cost is
WAITING, not compute. macOS 'auto' resolves to GPU, so the first pane needs
aterm_gpu_web (6.3MB) compiled INSIDE the shared worker, while the main thread
separately needs aterm_wasm (3.86MB) because a worker-backed term has no
`encode_key` — every keystroke routes through the main-thread CPU glue.

Rules any implementation must satisfy (each learned from a reverted change):
R1 no unconditional startup work (no eager probe/compile on terminal-less launches);
R2 never derive a bench delta between events that RACE;
R3 removing an await must not drop a side effect the awaiter relied on;
R4 don't read settings before they hydrate;
R5 visibility snapshotted at admit time goes stale on a mid-restore tab switch.

## 1. De-chain CPU compile from worker acquisition

**a) Safest shape**

Start two explicit single-flight lanes in the same turn:

- `mainCpuReady`: loads/registers the CPU glue needed by `encode_key_with_mode`.
- `workerLeaseReady`: loads font bytes, spawns the worker, and sends fonts.

Join them with `Promise.all` before exposing the controller as input-ready. This changes the critical path from `CPU + worker` to `max(CPU, worker)` without allowing an unencodable terminal.

Do not model CPU loading as an incidental part of font loading again. The worker font path is correctly independent already ([aterm-shared-render-worker.ts](src/renderer/src/lib/pane-manager/aterm/aterm-shared-render-worker.ts:319)); the serialization exists only in `startWarm` ([aterm-worker-prewarm.ts](src/renderer/src/lib/pane-manager/aterm/aterm-worker-prewarm.ts:67)).

**b) Silent loss and proof**

The dangerous side effect is CPU-glue registration. The present fire-and-forget call suppresses failure ([aterm-worker-loader.ts](src/renderer/src/lib/pane-manager/aterm/aterm-worker-loader.ts:45)); that can produce a visually working but untypable terminal.

Prove:

- Worker acquisition starts before CPU loading settles.
- A real pane observes the same CPU promise; it does not swallow rejection.
- No input handler becomes usable before registration completes.
- Every resolution ordering—CPU first, worker first, either failure, real pane racing prewarm—releases the prewarm lease exactly once.
- A first keystroke immediately after attachment never throws.

If preserving a frame before CPU readiness is essential, add an explicit input-ready state and buffer key descriptors. Do not rely on “the compile should finish before the user types.”

**c) Honest measurement**

Delete `wasm-ready → worker-ready`; those endpoints race after de-chaining. The current benchmark still derives that invalid phase ([startup-milestone-phases.mjs](tools/benchmarks/startup-milestone-phases.mjs:80)).

Report from a shared origin:

- warm-start → main CPU ready
- warm-start → worker booted
- warm-start → both ready
- startup → visible first frame

Also report each lane’s own start/end span.

**d) Do it?**

Yes, but treat it as correctness-oriented overlap, not a claimed 183 ms win. A real pane can already race ahead and acquire the worker, and this does not start the worker’s GPU module. The end-to-end gain may be small.

## 2. Prepare the worker engine before pane `init`

**a) Safest shape**

Do not put an ambient-settings hint on the `fonts` message. Add a distinct worker-scoped `prepareEngine(kind)` command that initializes the same single-flight promise later consumed by `buildGpuEngine` or `buildCpuEngine`. Keep `booted` as the immediate fonts/script-health acknowledgement; engine preparation gets a separate acknowledgement.

Make the engine decision pure and explicit:

1. First prove terminal demand: an active local restored terminal will mount, or an actual terminal-open action occurred.
2. Resolve `terminalGpuAcceleration` from the authoritative startup snapshot.
3. Run the GPU capability probe only inside that demand branch.
4. Pass the resulting decision token through prewarm and the first pane’s `init`. Do not reread the global store later.

The startup snapshot is available before it is installed into Zustand ([app-startup-hydration.ts](src/renderer/src/app-shell/app-startup-hydration.ts:144)). Therefore:

- If `snapshot.settings` exists, pass its mode directly to the warm plan.
- If it does not, spawn/font-warm only after terminal demand is known, then defer `prepareEngine` until `fetchSettings` completes.
- Never substitute `'auto'` for “not hydrated.”

This also fixes the existing design smell where `PaneManager` carries the setting but the worker loader independently rereads global state.

**b) Silent loss and proof**

Protect these contracts:

- Preparation must populate the exact `cpuInitPromise`/`gpuInitPromise` used by pane builds—never initiate a second wasm-bindgen initialization.
- Fonts `booted` must remain ahead of engine work, or the 4-second boot timeout will misclassify “alive and compiling” as wedged ([aterm-render-worker.ts](src/renderer/src/lib/pane-manager/aterm/aterm-render-worker.ts:340)).
- GPU failure must still trigger the existing CPU rebuild.
- Worker termination must cancel preparation naturally; a stale generation’s “prepared” acknowledgement cannot satisfy a new generation.
- Main-thread CPU glue must still load for keyboard encoding. Worker GPU readiness is not input readiness.

Prove zero GPU probe, worker spawn, or engine compile on a terminal-less launch; exactly one requested module initializes; `off` never prepares GPU; and prepared kind equals first-pane `init` kind. Compiling CPU after a genuine GPU failure is valid fallback, not an erroneous double compile.

**c) Honest measurement**

Instrument the actual awaited cost:

- `prepareEngine` module-init span.
- At pane `init`, time spent awaiting the shared module promise.
- pane `init` → first state.
- startup → visible first frame.
- compile count by engine kind.

The most useful number is “module wait paid after pane init.” It should approach zero when preparation wins the race. Do not subtract `module-ready` and `pane-init`.

**d) Do it?**

Yes. This removes work directly from the awaited first-pane path. But gate it on proven terminal demand; attaching it to the unconditional idle arm would repeat the rejected eager-work design.

## 3. Prioritize the currently visible pane

**a) Safest shape**

Replace FIFO entries with reprioritizable tickets, not a boolean captured at `admit()`.

At every slot grant, read the pane’s live visibility state. `PaneManager.suspendRendering()` and `resumeRendering()` already update `pane.startRenderingSuspended` synchronously ([pane-manager.ts](src/renderer/src/lib/pane-manager/pane-manager.ts:269)).

For the restore burst:

- Defer the initial drain by one microtask so all same-turn tickets can enter.
- Admit current visible tickets before hidden tickets.
- Preferably let the first visible build run alone until its engine/controller is ready, then restore concurrency two for background panes.
- On tab switch, reprioritize queued tickets immediately.
- Do not cancel or preempt an in-flight build; its canvas may already be transferred.
- Preserve FIFO within the same priority and the 20-second safety valve.

The existing queue grants the first two synchronously, so merely choosing visible waiters when slots are freed is insufficient ([aterm-pane-open.ts](src/renderer/src/lib/pane-manager/aterm/aterm-pane-open.ts:35)).

**b) Silent loss and proof**

Risks are queue ownership and longer hidden-pane buffering:

- Exactly one admission and release per ticket.
- Disposed queued panes are removed without consuming a slot.
- Timeout self-admission keeps counts correct.
- Hidden panes retain all buffered PTY/restore output while delayed.
- Equal-priority panes cannot starve.
- A tab switch before slot release changes which queued pane wins.
- A tab switch during an in-flight build does not cancel or poison its transferred canvas.

Test all of those with controlled deferred builds and visibility changes.

**c) Honest measurement**

Target the active tab explicitly. The existing pane milestone latches the first pane that boots, which need not be the visible pane.

Record per ticket:

- enqueue → admission
- admission → controller ready
- visible-pane demand → visible first presentation
- time until all restored panes are ready
- buffered/dropped output while hidden panes wait

The shipping metric remains startup → active visible terminal frame. Also watch total background completion so the foreground win is not hiding a severe restoration regression.

**d) Do it?**

Yes, if queue traces show the visible pane waiting. With eight tabs and a persisted-order FIFO, it can eliminate several build waves. If the visible pane is already admitted in the first pair in nearly every run, the win is illusory and this should not ship.
hook: Stop
hook: Stop Completed
tokens used
154,045
## Ranking by expected win / risk

1. **(3) Live visible-first admission** — likely the biggest win if the active tab is not already among the first two.
2. **(2) Demand-scoped worker module preparation** — meaningful, but requires a careful protocol and decision-owner change.
3. **(1) De-chain CPU glue and worker acquisition** — safe cleanup, probably a modest first-frame win by itself.

If traces show the visible pane already enters the first build pair consistently, swap (2) and (3).

## 1. De-chain CPU compile from worker acquisition

**a) Safest shape**

Start two explicit single-flight lanes in the same turn:

- `mainCpuReady`: loads/registers the CPU glue needed by `encode_key_with_mode`.
- `workerLeaseReady`: loads font bytes, spawns the worker, and sends fonts.

Join them with `Promise.all` before exposing the controller as input-ready. This changes the critical path from `CPU + worker` to `max(CPU, worker)` without allowing an unencodable terminal.

Do not model CPU loading as an incidental part of font loading again. The worker font path is correctly independent already ([aterm-shared-render-worker.ts](src/renderer/src/lib/pane-manager/aterm/aterm-shared-render-worker.ts:319)); the serialization exists only in `startWarm` ([aterm-worker-prewarm.ts](src/renderer/src/lib/pane-manager/aterm/aterm-worker-prewarm.ts:67)).

**b) Silent loss and proof**

The dangerous side effect is CPU-glue registration. The present fire-and-forget call suppresses failure ([aterm-worker-loader.ts](src/renderer/src/lib/pane-manager/aterm/aterm-worker-loader.ts:45)); that can produce a visually working but untypable terminal.

Prove:

- Worker acquisition starts before CPU loading settles.
- A real pane observes the same CPU promise; it does not swallow rejection.
- No input handler becomes usable before registration completes.
- Every resolution ordering—CPU first, worker first, either failure, real pane racing prewarm—releases the prewarm lease exactly once.
- A first keystroke immediately after attachment never throws.

If preserving a frame before CPU readiness is essential, add an explicit input-ready state and buffer key descriptors. Do not rely on “the compile should finish before the user types.”

**c) Honest measurement**

Delete `wasm-ready → worker-ready`; those endpoints race after de-chaining. The current benchmark still derives that invalid phase ([startup-milestone-phases.mjs](tools/benchmarks/startup-milestone-phases.mjs:80)).

Report from a shared origin:

- warm-start → main CPU ready
- warm-start → worker booted
- warm-start → both ready
- startup → visible first frame

Also report each lane’s own start/end span.

**d) Do it?**

Yes, but treat it as correctness-oriented overlap, not a claimed 183 ms win. A real pane can already race ahead and acquire the worker, and this does not start the worker’s GPU module. The end-to-end gain may be small.

## 2. Prepare the worker engine before pane `init`

**a) Safest shape**

Do not put an ambient-settings hint on the `fonts` message. Add a distinct worker-scoped `prepareEngine(kind)` command that initializes the same single-flight promise later consumed by `buildGpuEngine` or `buildCpuEngine`. Keep `booted` as the immediate fonts/script-health acknowledgement; engine preparation gets a separate acknowledgement.

Make the engine decision pure and explicit:

1. First prove terminal demand: an active local restored terminal will mount, or an actual terminal-open action occurred.
2. Resolve `terminalGpuAcceleration` from the authoritative startup snapshot.
3. Run the GPU capability probe only inside that demand branch.
4. Pass the resulting decision token through prewarm and the first pane’s `init`. Do not reread the global store later.

The startup snapshot is available before it is installed into Zustand ([app-startup-hydration.ts](src/renderer/src/app-shell/app-startup-hydration.ts:144)). Therefore:

- If `snapshot.settings` exists, pass its mode directly to the warm plan.
- If it does not, spawn/font-warm only after terminal demand is known, then defer `prepareEngine` until `fetchSettings` completes.
- Never substitute `'auto'` for “not hydrated.”

This also fixes the existing design smell where `PaneManager` carries the setting but the worker loader independently rereads global state.

**b) Silent loss and proof**

Protect these contracts:

- Preparation must populate the exact `cpuInitPromise`/`gpuInitPromise` used by pane builds—never initiate a second wasm-bindgen initialization.
- Fonts `booted` must remain ahead of engine work, or the 4-second boot timeout will misclassify “alive and compiling” as wedged ([aterm-render-worker.ts](src/renderer/src/lib/pane-manager/aterm/aterm-render-worker.ts:340)).
- GPU failure must still trigger the existing CPU rebuild.
- Worker termination must cancel preparation naturally; a stale generation’s “prepared” acknowledgement cannot satisfy a new generation.
- Main-thread CPU glue must still load for keyboard encoding. Worker GPU readiness is not input readiness.

Prove zero GPU probe, worker spawn, or engine compile on a terminal-less launch; exactly one requested module initializes; `off` never prepares GPU; and prepared kind equals first-pane `init` kind. Compiling CPU after a genuine GPU failure is valid fallback, not an erroneous double compile.

**c) Honest measurement**

Instrument the actual awaited cost:

- `prepareEngine` module-init span.
- At pane `init`, time spent awaiting the shared module promise.
- pane `init` → first state.
- startup → visible first frame.
- compile count by engine kind.

The most useful number is “module wait paid after pane init.” It should approach zero when preparation wins the race. Do not subtract `module-ready` and `pane-init`.

**d) Do it?**

Yes. This removes work directly from the awaited first-pane path. But gate it on proven terminal demand; attaching it to the unconditional idle arm would repeat the rejected eager-work design.

## 3. Prioritize the currently visible pane

**a) Safest shape**

Replace FIFO entries with reprioritizable tickets, not a boolean captured at `admit()`.

At every slot grant, read the pane’s live visibility state. `PaneManager.suspendRendering()` and `resumeRendering()` already update `pane.startRenderingSuspended` synchronously ([pane-manager.ts](src/renderer/src/lib/pane-manager/pane-manager.ts:269)).

For the restore burst:

- Defer the initial drain by one microtask so all same-turn tickets can enter.
- Admit current visible tickets before hidden tickets.
- Preferably let the first visible build run alone until its engine/controller is ready, then restore concurrency two for background panes.
- On tab switch, reprioritize queued tickets immediately.
- Do not cancel or preempt an in-flight build; its canvas may already be transferred.
- Preserve FIFO within the same priority and the 20-second safety valve.

The existing queue grants the first two synchronously, so merely choosing visible waiters when slots are freed is insufficient ([aterm-pane-open.ts](src/renderer/src/lib/pane-manager/aterm/aterm-pane-open.ts:35)).

**b) Silent loss and proof**

Risks are queue ownership and longer hidden-pane buffering:

- Exactly one admission and release per ticket.
- Disposed queued panes are removed without consuming a slot.
- Timeout self-admission keeps counts correct.
- Hidden panes retain all buffered PTY/restore output while delayed.
- Equal-priority panes cannot starve.
- A tab switch before slot release changes which queued pane wins.
- A tab switch during an in-flight build does not cancel or poison its transferred canvas.

Test all of those with controlled deferred builds and visibility changes.

**c) Honest measurement**

Target the active tab explicitly. The existing pane milestone latches the first pane that boots, which need not be the visible pane.

Record per ticket:

- enqueue → admission
- admission → controller ready
- visible-pane demand → visible first presentation
- time until all restored panes are ready
- buffered/dropped output while hidden panes wait

The shipping metric remains startup → active visible terminal frame. Also watch total background completion so the foreground win is not hiding a severe restoration regression.

**d) Do it?**

Yes, if queue traces show the visible pane waiting. With eight tabs and a persisted-order FIFO, it can eliminate several build waves. If the visible pane is already admitted in the first pair in nearly every run, the win is illusory and this should not ship.
codex=0
