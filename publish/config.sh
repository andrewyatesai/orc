# Repo-specific configuration for the central publication engine.
STAGING_REMOTE_DEFAULT="git@gh-andrewyatesai:andrewyatesai/orca-alab-staging.git"
CHECK_CMD_DEFAULT="test -s README.md && test -s LICENSE && test -s NOTICE && test -s THIRD-PARTY-NOTICES.md && test -s .gitleaks.toml && test -s resources/readme-hero.jpg"
# NOTE: this repo publishes under `mode = "mirror-head"` (full-source snapshot
# of dev origin/main). Only STAGING_REMOTE_DEFAULT is read on that path —
# mirror-head has no CHECK_CMD stage, so CHECK_CMD_DEFAULT is inert.
# The authoritative constellation version is package.json's top-level
# "version" (X.Y.0, VERSIONING.md): `pub version`/`pub bump` read and write
# it, and the engine's mirror-head promote reads it from the source commit to
# name, tag, and ledger-map each release. VERSION_DEFAULT was removed so a
# second declaration cannot drift from it. Upstream fork provenance (Orca
# 1.4.147) is a separate fact, recorded by the public v1.4.147-fork.1 tag.
# The landing-page transform T1 that this comment used to describe is dead
# code; see publish/transforms.sh and publish/DECISIONS.md.
