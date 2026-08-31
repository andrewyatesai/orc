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
- `post-promote` — optional executable hook `pub promote` runs from the repo
  root once the public push has landed (site follow-through: engine rebuild,
  download links, release notes). Env: `PUB_REPO_SLUG`, `PUB_PUBLIC_COMMIT`,
  `PUB_STAGING_COMMIT`, `PUB_VERSION`, `PUB_TAG` (only if the tag exists),
  `PUB_RELEASE_CLONE`, `PUB_DRY_RUN=1` under `--dry-run`; the rest of the
  environment is clean (`PUB_HOOK_ENV=NAME,NAME` forwards more). Its failure
  never un-promotes; `--skip-site` / `PUB_SKIP_SITE=1` skips it
- `.out/` — gitignored work area

Tiers: **dev** `andrewyatesai/<repo>` (private, full history) → **staging**
`andrewyatesai/<repo>-staging` (private, one snapshot commit, agents may push)
→ **release** `alabsystems/<repo>` (public; `pub promote` pushes the audited
staging tree straight to public `main` — no PR, no review branch, no TTY).

Usage: `publish/publish.sh stage` (dev → staging; `--dry-run`, `--check`) and
`publish/publish.sh promote` (staging → public; `--dry-run`, `--skip-site`).
Agents run both. What authorizes the public write is possession of the release
credential (`~/.secrets/gh_access_token_alabsystems` — the dev token cannot
reach alabsystems at all) plus an explicit `PUBLISH_RELEASE_REMOTE`, which
promote checks against the registry's release slug before any push (KEYS.md
owner decision 2026-08-23). Publishing at all remains the owner's call.
