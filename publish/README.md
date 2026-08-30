# publish/ — publication policy for this repo

Policy for publishing this repo lives here; the mechanism (the `pub` CLI,
guard baseline, registry, pin ledger) lives in the sibling `publication` repo.
`./publish.sh` is a shim that execs `pub` with this repo inferred from cwd.

> **This repo is registered `mode = "mirror-head"`.** The public repo
> `alabsystems/orca-alab` is a full-source snapshot of dev `origin/main`, not a
> curated export. Most of the policy surface below belongs to the *guarded
> export* path and is **inert here**: `transforms.sh` is never sourced,
> `manifest.txt` selects nothing (it is only checked for existence), and there
> is no `CHECK_CMD` stage. Snapshots **are** versioned — that changed on
> 2026-08-28; see `DECISIONS.md`. What actually decides the public
> tree is the central `baseline/path-deny.txt` (`docs/`, `publish/`, `.github/`
> never ship), the `andrewyatesai/*` → `alabsystems/*` org rewrite, and the
> `rust/aterm` public-gitlink remap. The repository's own `/README.md` is the
> public README. See `DECISIONS.md`.

- `manifest.txt` — allowlist of what is exported (only listed paths ship).
  **Inert under mirror-head:** required to exist, but it selects nothing.
- `config.sh` — staging remote, public-clone check, bounded optional check
  timeout, and optional private-dev `DEV_TAG_PREFIX_DEFAULT` (staging/public stay
  `v<version>`). **Under mirror-head only the staging remote is read**;
  `CHECK_CMD_DEFAULT` is inert. There is no `VERSION_DEFAULT` here — it was
  removed so a second declaration could not drift from `package.json`, which is
  the one authoritative version.
- `transforms.sh` — repo-specific export rewrites (optional).
  **Dead code here:** mirror-head has no transform stage and never sources it.
- `forbidden-extra.txt` — guard patterns ADDED to the central baseline (optional)
- `content-allow.txt` — narrow exceptions for `forbidden-extra.txt` only;
  central-baseline findings cannot be suppressed by repository policy
- `DECISIONS.md` — boundary log: what is excluded and why, scrub history
- `.out/` — gitignored work area

Tiers: **dev** `andrewyatesai/<repo>` (private, full history) → **staging**
`andrewyatesai/<repo>-staging` (private, one snapshot commit, agents may push)
→ **release** `alabsystems/<repo>` (public, agents promote — no PR, no review
branch, no TTY).

Usage: `publish/publish.sh stage` (dev → staging; `--dry-run`, `--check`) and
`publish/publish.sh promote` (staging → public). **Corrected 2026-08-30:** the
two lines above previously said promotion was human-only and PR-gated. That was
false — `pub promote` does not refuse a non-interactive caller, and non-interactive
promotes were measured across the constellation on 2026-08-27. What authorizes the
write is the release credential plus an explicit `PUBLISH_RELEASE_REMOTE` that
promote verifies against the registry's release slug before any push (KEYS.md
owner decision 2026-08-23). The same correction is recorded in the CLAUDE.md
versioning block.
