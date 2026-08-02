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

The public constellation version of this snapshot is `0.2.0` (committed as
VERSION_DEFAULT in `publish/config.sh`), following the constellation's
`major.minor.dev` scheme so `promote` accepts it. The app itself versions
independently as `X.Y.Z-fork.N` (see `docs/reference/fork-versioning.md`);
release binaries (dmg/zip) are distributed through the public ALab release
repository `alabsystems/orca-alab`, not from the development source repository
or via this landing-snapshot pipeline.

## Verification policy

The public-clone check validates the landing files exist and are non-empty; no
build is attempted because the snapshot ships no source.

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

## v0.2.0 boundary revision (2026-07-22 release audit)

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
