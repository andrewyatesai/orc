# Repo-specific configuration for the central publication engine.
STAGING_REMOTE_DEFAULT="git@gh-andrewyatesai:andrewyatesai/orca-alab-staging.git"
CHECK_CMD_DEFAULT="test -s README.md && test -s LICENSE && test -s NOTICE && test -s THIRD-PARTY-NOTICES.md && test -s .gitleaks.toml && test -s resources/readme-hero.jpg"
VERSION_DEFAULT="0.2.0"
# NOTE: this repo publishes under `mode = "mirror-head"` (full-source snapshot
# of dev origin/main). Only STAGING_REMOTE_DEFAULT is read on that path —
# mirror-head has no CHECK_CMD stage and does not version its snapshots, so
# CHECK_CMD_DEFAULT and VERSION_DEFAULT below are inert. VERSION_DEFAULT is kept
# in step with package.json (0.2.0) so it cannot contradict it. The landing-page
# transform T1 that this comment used to describe is dead code; see
# publish/transforms.sh and publish/DECISIONS.md.
