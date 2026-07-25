# publish/ — publication policy for this repo

Policy for publishing this repo lives here; the mechanism (the `pub` CLI,
guard baseline, registry, pin ledger) lives in the sibling `publication` repo.
`./publish.sh` is a shim that execs `pub` with this repo inferred from cwd.

- `manifest.txt` — allowlist of what is exported (only listed paths ship)
- `config.sh` — staging remote, public-clone check, bounded optional check
  timeout, version fallback, and optional private-dev `DEV_TAG_PREFIX_DEFAULT`
  (staging/public stay `v<version>`)
- `transforms.sh` — repo-specific export rewrites (optional)
- `forbidden-extra.txt` — guard patterns ADDED to the central baseline (optional)
- `content-allow.txt` — narrow exceptions for `forbidden-extra.txt` only;
  central-baseline findings cannot be suppressed by repository policy
- `DECISIONS.md` — boundary log: what is excluded and why, scrub history
- `.out/` — gitignored work area

Tiers: **dev** `andrewyatesai/<repo>` (private, full history) → **staging**
`andrewyatesai/<repo>-staging` (private, one snapshot commit, agents may push)
→ **release** `alabsystems/<repo>` (public, human-only promote via PR).

Usage: `publish/publish.sh stage` (dev → staging; `--dry-run`, `--check`) and,
for HUMANS at a terminal only, `publish/publish.sh promote` (staging → public).
