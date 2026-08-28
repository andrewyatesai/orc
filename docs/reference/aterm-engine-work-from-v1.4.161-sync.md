# aterm Engine Work Filed from the v1.4.161 Upstream Sync

> **Filed at the v1.4.161 sync.** The tree has since advanced to upstream
> **v1.4.165-rc.0** (`5fb3d4781`), so items below described as arriving "with the
> v1.4.162 sync" have already landed upstream-side; their engine-side status is
> not tracked by this document.

Behavioral specs the v1.4.161 merge could not adopt as code because the fork's
aterm engine replaced the xterm.js layer upstream patched. Each is engine work
against `rust/aterm` (or the renderer glue in
`src/renderer/src/lib/pane-manager/aterm/`), not a merge blocker. Sources are
upstream commits on `upstream/main`; some are post-161 and re-arrive with the
v1.4.162 sync — the engine behavior should exist either way.

## 1. IME composition lifecycle (spec: `fe6f929c6e`, post-161)

Upstream patched @xterm's core (971 lines) to fix cross-platform IME. aterm's
input path must handle the same semantics natively:

- Enter during an active composition commits the text, never sends `\r` early
  (deferred-newline).
- Composition transactions have one owner: native events routed while a
  composition is open must not double-deliver through the keydown path
  (Korean/Chinese dedup).
- Composition state survives pane refocus; a canceled composition leaves no
  stray text. Linux ibus-hangul is upstream's regression environment.

Verify against: aterm kitty-keyboard conformance suite + a composition case
set; upstream's new renderer IME modules name the cases.

## 2. Abandoned synchronized-output bracket across hide/reveal (spec: `97cb32c1cc`, in-tag)

A TUI hidden mid `?2026h`/`?2026l` bracket must not leave the engine's
synchronized-output latch held; on reveal the pane must repaint fully without
waiting for a watchdog. Confirm aterm releases the latch on pane
hide/park/reveal transitions (alt-screen agent TUIs during worktree switches
are the trigger).

## 3. Stale TUI modes after a hard-killed child (spec: `c0734f039d`, post-161)

A TUI killed hard (SIGKILL/OOM) under a surviving shell leaves mouse tracking,
focus reporting, and kitty-keyboard flags armed — pointer moves land as typed
SGR reports at the prompt. aterm owns mode lifecycle engine-side: on the
confirmed return-to-shell transition, disarm stale DEC private modes and the
kitty keyboard stack. The fork's pty-connection retains a POST_REPLAY reset
hook; decide whether engine-side disarm supersedes it.

## 4. Mode-2031 replies only at subscribed chunk ends (spec: `2dac0741b4`, post-161)

fish toggles DECSET 2031 around every prompt. Reply decisions must be made at
PTY-chunk boundaries with a cross-chunk tail (reply only when the chunk ends
subscribed), or replies land as literal text in a child that took the tty.
The fork's renderer keeps a 2031 observer; the engine-side query-reply
election (query authority doc) is the right final owner.

## 5. Hidden-pane retention policy for SSH/remote worktrees (policy port: `a7c8b8e071`, post-161)

Not engine internals but engine-adjacent: upstream bounded hidden-worktree
terminal retention (force-park budget: 12 hidden worktrees / 45 min TTL,
per-pane eviction exemptions, deferred side-effect queue cap). The OOM class
applies to aterm panes; port the policy onto aterm pane parking, reimplement
the reveal repaint from the daemon/headless model (upstream's xterm repaint
mechanics are superseded).

## GPU-path symptom audit (from upstream revert `3a80fbe162`, in-tag)

Upstream reverted four rendering changes for flashing/lost content; one is the
fork's merge-base commit (`8f5a45401f`, parked-terminal restore flash). Audit
the aterm GPU path (dirty-band present, scroll-blit, reveal repaint) for the
same symptom class: flash on parked-terminal restore, stale frame after
resume, lost content on visibility flips. The perf-proof lane's
keydown→echo-visible instrument plus a hide/reveal fixture is the right gate.
