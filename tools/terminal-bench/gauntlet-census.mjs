// The regret-class ratchet — the `census` gauntlet axis.
//
// Raw inventory legitimately drifts with every feature/upstream merge, so this gate
// enforces DIRECTION, not values: the delivery-reliability shim and the watched god
// objects must never grow. Growth is REVIEW (an upstream merge may grow them for a
// legitimate reason) — the agent triages and updates the baseline knowingly.\n//
// Extracted from gauntlet.mjs to keep that file under its max-lines cap; the host
// passes in the shared primitives (repo root, bench dir, sh).

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function censusGate({ repo, here, benchDir, sh }) {
  const CENSUS_BASELINE = join(here, 'census-ratchet.json')
  const BENCH_DIR = benchDir

  mkdirSync(BENCH_DIR, { recursive: true })
  const out = join(BENCH_DIR, 'census.json')
  sh('node', [join(repo, 'tools', 'repo-census.mjs'), '--json', out])
  const snap = JSON.parse(readFileSync(out, 'utf8'))
  const current = {
    shimWholeFileLoc: snap.deliveryReliabilityShim.wholeFileTotalLoc,
    ...snap.watchedFiles
  }
  if (!existsSync(CENSUS_BASELINE)) {
    return {
      status: 'REVIEW',
      metrics: current,
      detail: `no ratchet baseline — review these numbers, then commit them as ${CENSUS_BASELINE}`
    }
  }
  const baseline = JSON.parse(readFileSync(CENSUS_BASELINE, 'utf8'))
  const grew = []
  const shrank = []
  for (const k of Object.keys(current)) {
    // The scan set is the CENSUS, not the baseline: a key dropped from the baseline
    // would otherwise stop being watched with nothing to say so.
    if (!(k in baseline)) {
      grew.push(`${k}: no ceiling in census-ratchet.json — the ratchet stopped watching it`)
    }
  }
  for (const [k, limit] of Object.entries(baseline)) {
    if (k.startsWith('_') && typeof limit !== 'number') {
      continue // `_` keys are the re-baseline rationale; a NUMBER under `_` is a ceiling in hiding
    }
    const cur = current[k]
    if (typeof limit !== 'number') {
      // A ceiling that is not a number can never be exceeded — that is a silent hole, not a pass.
      grew.push(`${k}: baseline ceiling ${JSON.stringify(limit)} is not a number`)
    } else if (typeof cur !== 'number') {
      grew.push(`${k}: missing from census output`)
    } else if (cur > limit) {
      grew.push(`${k}: ${cur} > baseline ${limit}`)
    } else if (cur < limit) {
      shrank.push(`${k}: ${cur} < baseline ${limit} — ratchet can tighten`)
    }
  }
  return {
    status: grew.length ? 'REVIEW' : 'PASS',
    metrics: { ...current, head: snap.gitHead },
    detail:
      [
        grew.length
          ? `regret class GREW (intentional? update census-ratchet.json knowingly): ${grew.join('; ')}`
          : null,
        shrank.length ? shrank.join('; ') : null
      ]
        .filter(Boolean)
        .join(' · ') || 'regret class did not grow',
    censusSnapshot: snap
  }
}
