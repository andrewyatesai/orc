# Security Audit Campaign — July 2026

A sustained, multi-service **dual-lens** audit-and-fix campaign on the orca-alab
fork. Every finding was produced by a Claude multi-agent audit, landed, then
independently re-reviewed by **Codex CLI** (`gpt-5.6-sol`) as a second lens, with
regressions in the fixes themselves fixed-forward. All work is on `main` and
pushed to origin.

**Result:** 5 services fully closed · **45 Claude + 11 Codex findings** fixed,
verified, and pushed · 1 self-inflicted regression caught and repaired ·
1 infrastructure fix.

---

## Method

For each service:

1. **Audit** — a multi-agent workflow scans one service across 4 dimensions
   (correctness/data-loss, security/trust-boundary, concurrency/leaks,
   protocol/edge), each finding adversarially verified.
2. **Land** — I independently gate (vitest `--config config/vitest.config.ts`,
   no-emit typecheck, oxlint), commit pathspec-scoped in logical groups, push.
3. **Second lens** — `codex review --base <sha>` on the landed diff.
4. **Fix-forward** — Codex findings verified, fixed, pinned, re-gated, pushed.

**The campaign's central finding: neither lens alone ships correct code.** Codex
found real defects *in my own fixes* on **4 of the 5 services** — including
over-corrections where a security fix broke a legitimate feature or bricked
startup. My own Claude regression reviews twice returned false "0 regressions"
that Codex disproved.

---

## Services

| Service | Claude | Codex fix-forward | Headline |
|---|---:|---:|---|
| SSH / relay lifecycle | 11 | 2 | Both Codex hits were defects in my own SFTP fix |
| Browser / CDP | 11 | 4 | DNS-rebinding CDP hijack; 2 P1 regressions in my fix |
| Preload / IPC trust boundary | 8 | **0 — clean** | Generic `ipcRenderer` passthrough on `window.electron` |
| Observability / diagnostics | 7 | 2 | 5 secret-redaction leaks into the uploaded bundle |
| Source-control / providers | 12 | 3 | Cross-provider SSRF / token exfiltration |

---

## Highest-severity fixes

### Browser / CDP
- **DNS-rebinding CDP hijack** — the CDP WebSocket proxy had no Host/Origin
  validation; any web page (`attacker.com` → `127.0.0.1`) could open a CDP socket
  and drive the *authenticated* browser (RCE-grade). Now loopback-bound,
  Origin-rejected, `maxPayload`-capped, with bounded outbound buffering.
- **Camera/microphone failed *open*** on Linux/Windows (auto-granted to every
  origin) → now fail-closed and origin-scoped.
- **`clipboard-read` auto-granted to every origin** (silent clipboard exfil) →
  removed from the blanket grant; the trusted `orca clipboard read` command keeps
  working via a command-scoped, refcounted grant.
- Plaintext cookie-DB orphans reclaimed; symlink-follow into the bundle closed;
  origin-bar renderer leak plugged; `anti-detection` `Permissions.query` shim
  fixed so pages subscribing to permission changes no longer crash.

### Preload / IPC trust boundary
- **`window.electron` was a generic `ipcRenderer` passthrough** — the renderer
  could `invoke`/`send`/`on` to *arbitrary* channels, plus a full `process.env`
  copy and `webUtils`. Reduced to a frozen `{platform, versions}` snapshot.
- **Renderer-triggered main-process crash** — six unguarded `pty:*` listeners
  dereferenced `args.id`; a payload-less send threw synchronously and killed main.
- **Renderer-reload resource leaks** — native-chat transcript watches, remote
  runtime-env RPC streams, and coordinator daemon sockets all tore down only on
  `'destroyed'` (which never fires on a same-WebContents reload). Now tied to the
  full webContents lifecycle.
- mobile-markdown relay refactored from one ipcMain listener *per in-flight
  request* (MaxListeners warning, O(N) fan-out) to an O(1) shared dispatcher that
  preserves per-request sender validation.

### Observability / diagnostics (secret egress path)
- **Five redaction gaps** that leaked to disk *and* the uploaded bundle:
  connection-string passwords (`postgres://user:pw@…`), `Authorization:
  Basic/Digest` tails, GitLab/Google API keys, `Buffer`/`TypedArray` secret
  bytes, and secrets in object *keys*. All fail-closed; regexes length-bounded
  (no ReDoS).
- **Symlink-into-egress** — a rotated log slot swapped for a symlink was
  dereferenced into the upload (arbitrary-file-read). Bound to an `O_NOFOLLOW`
  descriptor with an `nlink` check (closing a TOCTOU + hardlink bypass).
- Unbounded upload hang → absolute wall-clock deadline.

### Source-control / providers
- **Cross-provider SSRF / token exfiltration** — Gitea and Azure DevOps PATs were
  attached to a git-remote-derived host with no validation, so a malicious/mistyped
  remote could send the credential to an attacker host or to cloud-metadata
  `169.254.169.254`, over cleartext. Now gated by a shared `giteaTokenAllowedForHost`
  policy (https-or-loopback, trusted/configured host, internal literals refused),
  applied on **both** the read and write paths.
- Same-origin-only redirects + a 16 MiB bounded response body on the shared request
  helper; duplicate-PR fix (truncated branch scan); WSL parity; defensive mapper
  parsing.

### SSH / relay
- Relay→client response *hijack* (any attached client could resolve another's
  pending request) and agent-exec lanes not keyed by client; FD leak on disconnect;
  zombie-connection reconnect race; **non-atomic SFTP upload** made atomic
  (temp-sibling + rename, short-name staging under NAME_MAX, awaited cleanup).

---

## Do-no-harm: regressions caught and repaired

The user's explicit concern was that fixes might introduce bugs. Three did, and
each was caught before or shortly after landing:

1. **SSH atomic-staging broke `ssh-filesystem-provider` tests** — my temp+rename
   change needed `sftp.rename`/`unlink`, absent from a consumer's mock, hanging to
   a 30 s timeout. Latent because my per-service gates never covered
   `src/main/providers`; surfaced by a broad 18 k-test run. Causation proven by
   reverting; fixed.
2. **Source-control SSRF guard over-blocked loopback** — breaking the SSH-tunnel /
   local-instance flow (`http://127.0.0.1:port`), a legitimate case pinned by
   consumer *integration* tests. Refined so loopback is a trusted recipient while
   metadata/private stay blocked.
3. **Codex then caught two more in that refinement** — a `127.` *prefix* match let
   `127.attacker.example` leak the token; the write path trusted any https origin;
   and my redirect loop replayed POST on 301/302/303 (a potential duplicate PR).
   All fixed via a shared policy + proper redirect method rewriting, and pinned.

---

## Infrastructure

- **Vitest resolves `.ts` before `.js`** — a stray compiled `.js` next to its `.ts`
  under `src/` (from a `tsc --build`, IDE tsserver, or aborted build) would be
  silently tested instead of source. Listing `.ts`/`.tsx` first in the vitest
  `resolve` makes source win. *(Note: an earlier hypothesis that the `typecheck`
  scripts emit these was empirically disproven — the composite lanes emit zero
  stray `.js`; this fix is defense-in-depth regardless of source.)*

---

## Open follow-ups

1. **Read-path parity gap** — the `gitea` / `bitbucket` / `azure-devops` *read*
   helpers still use unbounded `response.json()` + default follow-redirect (the
   *write* path got both). Lower severity (GET paths); Codex did not rate it
   must-fix.
2. **Next-service candidates** — computer-use (screenshots / input injection /
   emulator), runtime-RPC, automations, skills.

---

## Reproducing the second lens

```
codex review --base <sha-before-the-round>     # default instructions; not combinable with a prompt
codex review --commit <sha>                    # per-commit
```

Treat Codex findings with the same rigor as any other: verify real, reachable, and
introduced-by-the-change before fixing (it can false-positive). Across this
campaign it produced no false positives on confirmed findings and caught defects
the Claude verify passes missed on every service but one.
