# Publish-boundary decisions — orca-alab development

Initial classification: 2026-07-21.

## Scope of the snapshot

**Superseded 2026-07-22** (registry commit `8ee1f93`, "orca-alab back to
mirror-head full-source public snapshot"): the public repo is a full-source
snapshot of dev HEAD, not the landing page described below. The original
classification is kept for provenance; where the two disagree, the registry
mode wins.

What ships today, and what makes it publishable — each of these was a real
guard failure fixed on 2026-08-01, not a hypothetical:

- **Everything except the constellation's denied prefixes.** `docs/`, `publish/`
  and `.github/` are removed by `baseline/path-deny.txt`, which no repo may
  opt out of. Documents that referenced `docs/` were reworded to state their
  constraint inline, because a link into an unexported directory is a dead link
  for every public reader.
- **The dev org is rewritten, not shipped.** `mirror_org_rewrite` applies the
  same `org_rewrite` the guarded export path uses. Prose and config that named
  the org outside a rewritable slug were fixed at the source instead.
- **The `rust/aterm` gitlink is remapped to its public release.** A dev sha can
  never exist in a rewritten-history snapshot repo, so `mirror_public_gitlinks`
  rewrites the pin through `mappings.json` and refuses to publish when the
  dependency has not been promoted. This is why aterm promotes first.
- **Credential-shaped fixtures are assembled at runtime.** The redaction tests
  and the local HTTPS test certificate — the ones this document predicted would
  flag — no longer contain literal keys, so gitleaks sees no secret while the
  tests still exercise one.
- **Cargo checksum entropy is adjudicated, not allowlisted.** The engine clears
  `generic-api-key` hits only inside verified vendored crates and Cargo.lock
  dependency regions; every other finding still fails the publish.

- **No transform runs, and no manifest selects.** mirror-head has no
  `transforms.sh` stage at all — the engine states it by name: "Unlike the
  guarded export path, mirror-head has no `transforms.sh` (orca-alab's
  committed one is silently never run)" (publication
  `crates/pub/src/mirror.rs`, `org_rewrite_tree` header). `publish/manifest.txt`
  must still **exist** — the run dies without it — but it is an existence probe,
  not an allowlist; it selects nothing. Consequently **the repository's own
  `/README.md` IS the public README**, unmodified. `publish/transforms.sh`
  carries a dead-code banner saying so.

`FEATURE_WALKTHROUGH.md` now ships with the source it cites.

## Original classification (2026-07-21, superseded)

The public candidate was a project landing snapshot: `README.md`, `LICENSE`,
`NOTICE`, `THIRD-PARTY-NOTICES.md`, the mandatory Gitleaks configuration, and
the app icon and hero image the README embeds. It intentionally did not publish
the application source tree, walkthrough, build system, internal documentation,
release machinery, or development-agent instructions. The concerns it raised
about app source — the submodule gitlink, the committed test-only RSA key, and
the need for a transform set and public-clone strategy — were all real; they are
resolved above rather than avoided.

## Versioning

**mirror-head does not version its snapshots** — a mirror-head run reports a
null version and there is no `promote` tag to satisfy. `VERSION_DEFAULT="0.2.0"`
in `publish/config.sh` is therefore inert here; it is kept only so the file
matches the constellation's shape and so it does not contradict `package.json`.

The app versions on the ALab-owned `MAJOR.MINOR.0` line, **0.2.0** today (see
`docs/reference/fork-versioning.md`). The former `X.Y.Z-fork.N` app scheme was
retired in `7277b375e`; the ALab line restarted at v0.1.0 in `66d754673`. Release
binaries (dmg/zip) are distributed through the public ALab release repository
`alabsystems/orca-alab`, not from the development source repository.

## Verification policy

**mirror-head has no `CHECK_CMD` stage** — the run records it as `skipped`
unconditionally, so `CHECK_CMD_DEFAULT` in `publish/config.sh` is inert too. The
guards that do run are the central ones: path-deny, the org rewrite plus its
`scan_private_refs` residual check, the public-gitlink remap, and gitleaks. No
build is attempted, even though the snapshot now ships the full source tree.

## Source-publication audit (2026-07-22)

Full-source staging was requested and measured against the central guard
baseline. It is structurally blocked today on three independent walls:

1. **229 files** under shippable paths contain `/Users/<name>` fixture or
   comment paths — every one a central `forbidden-content` hit with no
   exception path.
2. The **pinned aterm WASM binaries** embed an engine doc-string containing a
   centrally forbidden term (`ultracode`); the pin system forbids altering
   these bytes, so clearing it requires an aterm-side source change, wasm
   rebuild, and re-pin.
3. Secret-shaped test fixtures (PEM headers, `ghp_`/`xox`/`AKIA`/`sk-` tokens)
   in ~7 files — gitleaks and the baseline both refuse them, by design.
   The former fourth wall is closed: `rust/aterm` now has the public home
   `alabsystems/aterm`, and the pinned submodule uses it.

Until the remaining three campaigns run, the landing snapshot remains the
staged boundary.

## v0.2.0 boundary revision (2026-07-22 release audit, superseded)

**Superseded the same day** by the move to `mode = "mirror-head"` recorded at
the top of this file. Transform T1 below never ran again after that switch, and
`FEATURE_WALKTHROUGH.md` is no longer excluded — it ships with the source it
cites. Kept for provenance; where this section and the mirror-head scope
disagree, the scope wins.

The v0.1.0 snapshot shipped the dev repo's README/walkthrough verbatim, which
made false claims on a 6-file snapshot (build instructions with no source and
"built from this repository"). Fixes:

- Transform T1 now **replaces** README.md at export with a purpose-written
  public landing page: downloads point at THIS repo's Releases (binaries are
  mirrored there, since the org rewrite forbids referencing the dev org), the
  two version lines (v0.x snapshot tags vs 1.4.x-fork.N app versions) are
  explained, and aterm links to its public `alabsystems/aterm` repository.
- FEATURE_WALKTHROUGH.md is **excluded** until a public-appropriate edition
  exists — its provenance commands and file citations dangle without source.
- The README hero image moved to `resources/readme-hero.jpg` (exported), so
  the landing page keeps its product visual.
- Relicensed: LICENSE is Apache-2.0, NOTICE carries fork copyright, upstream
  MIT notice preserved in THIRD-PARTY-NOTICES.md (which also re-quotes the
  aterm NOTICE at the current pin).

## 2026-08-28 — Versioned, mapped, tagged releases (owner directive)

Mirror-head describes HOW the content is cut, not a licence to skip the
constellation release pattern. From this date every public snapshot is a
versioned release: the engine's mirror-head promote reads the version from the
source commit, refuses to re-release an already-tagged version, appends a
mappings.json row (dev sha -> public sha, trees, version), and pushes the
annotated `vX.Y.0` tag to alabsystems/orca-alab.

The ONE authoritative version is package.json's top-level "version" — the
"v0.x snapshot tags" line this file already anticipated. It was reset from the
upstream 1.4.x app version when the fork was renamed orca-alab; upstream
lineage remains recorded solely by the public `v1.4.147-fork.1` tag.
VERSION_DEFAULT was removed from config.sh so nothing can drift from
package.json. The 2026-08-27 snapshot (public 007371bbc2d3, cut from dev
cb2c916c2366) is backfilled in the ledger as v0.2.0.
