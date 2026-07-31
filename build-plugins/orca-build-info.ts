import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Build provenance for the About section, baked in at build time (a packaged app
// has no git repo / rust/aterm tree to read at runtime). Best-effort: any piece
// that can't be resolved (no git, missing file) degrades to 'unknown' rather than
// failing the build. See `ORCA_BUILD_INFO` in src/types/build-constants.d.ts.
function git(args: string): string {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}
export function computeOrcaBuildInfoLiteral(): string {
  let orcaVersion = 'unknown'
  try {
    orcaVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    /* keep unknown */
  }
  // aterm is a pinned git submodule; its checked-out commit IS the engine version.
  const atermRevFull = git('-C rust/aterm rev-parse HEAD')
  const atermRev = atermRevFull ? atermRevFull.slice(0, 12) : 'unknown'
  // The last upstream re-sync. Both subject conventions are in history —
  // "Merge upstream stablyai/orca (…)" and "merge: upstream stablyai/orca v… (…)" —
  // so match case-insensitively or the newest sync is missed and About reports a
  // stale alignment (a 1.4.161 build claimed v1.4.147-rc.4).
  const mergeLine = git('log -1 -i -E --grep="^merge:? upstream" --format="%h %s"')
  let upstreamAligned = 'unknown'
  if (mergeLine) {
    const sep = mergeLine.indexOf(' ')
    const hash = sep === -1 ? mergeLine : mergeLine.slice(0, sep)
    const subject = sep === -1 ? '' : mergeLine.slice(sep + 1)
    const version = subject.match(/v?\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? ''
    upstreamAligned = version ? `${version} (${hash})` : hash
  }
  const info = {
    orcaVersion,
    orcaCommit: git('rev-parse --short HEAD') || 'unknown',
    orcaCommitDate: git('show -s --format=%cI HEAD') || 'unknown',
    atermRev,
    upstreamFork: 'stablyai/orca',
    upstreamAligned
  }
  return JSON.stringify(info)
}
