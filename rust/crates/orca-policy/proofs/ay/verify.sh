#!/usr/bin/env bash
# Copyright 2026 Andrew Yates
# SPDX-License-Identifier: Apache-2.0
#
# Aggregator for the orca-policy proof bundles. The crate holds the fleet's two
# authority decisions (play-path containment, fleet-grant authorization), so its
# refusals carry their own re-checkable proofs rather than resting on the tests
# that shipped alongside them.
#
# The E1 gate (tools/terminal-bench/gauntlet-certificates.mjs) auto-discovers any
# crate with a proofs/ay/verify.sh, so adding a bundle here enrolls it with no
# further wiring. Each bundle SKIPS (exit 0) when `ay` is absent.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rc=0
for bundle in grant_authority; do
  echo "=== $bundle ==="
  bash "$DIR/$bundle/verify.sh" || rc=1
  echo
done
if [ "$rc" = 0 ]; then echo "orca-policy proofs/ay: ALL BUNDLES DISCHARGED (or skipped) ✓"; else echo "orca-policy proofs/ay: FAILED ✗"; fi
exit "$rc"
