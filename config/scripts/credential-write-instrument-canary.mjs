// KNOWN-ANSWER SELF-TEST FOR THE CLASSIFICATION RESOLVERS.
//
// SCOPE, precisely — this does NOT cover every resolver the report owns. It
// drives the secrecy detector, the guard resolver and the escape detector
// against fixture sinks it supplies itself via `buildSinkIndex(project, {seeds})`.
// It therefore never exercises the real catalog (FS_SINKS, FS_PROMISES_SINKS,
// FILE_HANDLE_SINKS, SFTP_SINKS, STREAM_SINKS). Measured consequence: deleting
// `writeFileSync` from FS_SINKS takes the report from 168 sites to 8 and the
// calibration still passes, because a sink that is never probed cannot appear in
// `unresolvedBaseSinks`. A shrinking site count is the symptom to watch for; the
// canary will not catch it.
//
// This is the report's ONE hard failure. A report assembled from a damaged
// instrument is worse than no report, because a shrunken finding list reads
// exactly like a clean codebase: a resolver whose failure mode is "nothing
// found" cannot tell "nothing is there" from "I could not look".
//
// So before any repository analysis happens the reporter runs the whole
// pipeline over synthetic sources whose answers are fixed by construction, in
// BOTH directions:
//
//   MUST-FIND      a write the detector has to see (each is a distinct
//                  mechanism: a plain call, a renamed import, a namespace
//                  member, a computed key, a wrapper, a concatenated name, a
//                  template-assembled name)
//   MUST-NOT-FIND  a shape that is not a write, or not a secret
//   MUST-GATE      a write the guard resolver has to accept
//   MUST-NOT-GATE  a predicate call in the wrong branch, the wrong polarity, a
//                  dead branch, another function, or a same-named local stub
//
// Any mismatch aborts the run with a non-zero exit and NOTHING is printed.
// Weakening a COVERED resolver breaks the MUST-FIND / MUST-GATE half; loosening
// one breaks the MUST-NOT half. An instrument that fails its calibration has no
// readings, so there is nothing to publish. Damage to the sink catalog is out of
// scope — see the SCOPE note above.
//
// What this cannot catch, stated plainly: a change that special-cases these
// fixtures, and a hole shared by both the canary and the detector (the canary
// is written from the same understanding of the world). It is calibration, not
// a proof.

import ts from 'typescript-api'

import { createInMemoryProject } from './typescript-symbol-resolution.mjs'
import { buildSinkIndex, classifyCall } from './credential-write-sink-model.mjs'
import { secrecySignals } from './credential-write-payload-shape.mjs'
import { resolvePolicyPredicates, sanctionedGuardFor } from './credential-write-policy-guard.mjs'

const FIXTURE_DIR = '__semantic-gate-fixture__'

const DISK = `export function writeFileSync(destination: string, bytes: string, options?: unknown): void {
  void destination
  void bytes
  void options
}
export const diskNamespaceMarker = 1
`

const POLICY = `export function allowsPlaintextPersistedSecret(): boolean {
  return process.env.ORCA_ALLOW_PLAINTEXT_PERSISTED_SECRETS === '1'
}
export function unrelatedFlag(): boolean {
  return true
}
`

const SEEDS = [
  { module: `${FIXTURE_DIR}/disk.ts`, name: 'writeFileSync', pathSlots: [0], payloadSlots: [1] }
]
const REGISTRY = [{ module: `${FIXTURE_DIR}/policy.ts`, name: 'allowsPlaintextPersistedSecret' }]

/** Each case is one line of source plus the answer the pipeline must produce.
 *  `writes` counts classified sites that carry a secret signal; `gated` counts
 *  the subset a sanctioned predicate selects. */
const CASES = [
  {
    id: 'plain-write',
    source: `import { writeFileSync } from './disk'
export function save(p: string, apiToken: string) { writeFileSync(p, apiToken) }`,
    writes: 1,
    gated: 0
  },
  {
    id: 'renamed-import',
    source: `import { writeFileSync as put } from './disk'
export function save(p: string, apiToken: string) { put(p, apiToken) }`,
    writes: 1,
    gated: 0
  },
  {
    id: 'namespace-member',
    source: `import * as disk from './disk'
export function save(p: string, apiToken: string) { disk.writeFileSync(p, apiToken) }`,
    writes: 1,
    gated: 0
  },
  {
    id: 'computed-key-folds',
    source: `import * as disk from './disk'
export function save(p: string, apiToken: string) { disk['write' + 'FileSync'](p, apiToken) }`,
    writes: 1,
    gated: 0
  },
  {
    id: 'concatenated-destination',
    source: `import { writeFileSync } from './disk'
export function save(dir: string, raw: string) { writeFileSync(dir + '/to' + 'ken' + '.json', raw) }`,
    writes: 1,
    gated: 0
  },
  {
    id: 'template-destination',
    source: `import { writeFileSync } from './disk'
export function save(dir: string, raw: string) { writeFileSync(\`\${dir}/oauth-credentials.json\`, raw) }`,
    writes: 1,
    gated: 0
  },
  {
    id: 'computed-payload-key',
    source: `import { writeFileSync } from './disk'
export function save(p: string, bag: Record<string, string>) { writeFileSync(p, bag['pass' + 'word']) }`,
    writes: 1,
    gated: 0
  },
  {
    // The inner writeFileSync names nothing secret; the wrapper call does. One
    // site, at the call that can actually be reviewed.
    id: 'wrapper-forwarding',
    source: `import { writeFileSync } from './disk'
function atomically(target: string, bytes: string) { writeFileSync(target, bytes) }
export function save(p: string, apiToken: string) { atomically(p, apiToken) }`,
    writes: 1,
    gated: 0
  },
  {
    id: 'type-only-import-is-not-a-door',
    source: `import type { writeFileSync } from './disk'
export type Writer = typeof writeFileSync
export function save(apiToken: string) { void apiToken }`,
    writes: 0,
    gated: 0
  },
  {
    id: 'local-shadow-is-a-different-declaration',
    source: `function writeFileSync(p: string, bytes: string) { void p; void bytes }
export function save(p: string, apiToken: string) { writeFileSync(p, apiToken) }`,
    writes: 0,
    gated: 0
  },
  {
    id: 'no-secret-name-no-site',
    source: `import { writeFileSync } from './disk'
export function save(p: string, bytes: string) { writeFileSync(p, bytes) }`,
    writes: 0,
    gated: 0
  },
  {
    id: 'comment-and-string-do-not-create-a-write',
    source: `// writeFileSync(tokenPath, apiToken)
const sample = 'writeFileSync(tokenPath, apiToken)'
export function save() { return sample }`,
    writes: 0,
    gated: 0
  },
  {
    id: 'guard-selects-the-branch',
    source: `import { writeFileSync } from './disk'
import { allowsPlaintextPersistedSecret } from './policy'
export function save(p: string, apiToken: string) {
  if (allowsPlaintextPersistedSecret()) { writeFileSync(p, apiToken) }
}`,
    writes: 1,
    gated: 1
  },
  {
    id: 'guard-early-return',
    source: `import { writeFileSync } from './disk'
import { allowsPlaintextPersistedSecret } from './policy'
export function save(p: string, apiToken: string) {
  if (!allowsPlaintextPersistedSecret()) { return }
  writeFileSync(p, apiToken)
}`,
    writes: 1,
    gated: 1
  },
  {
    id: 'guard-wrong-polarity-does-not-gate',
    source: `import { writeFileSync } from './disk'
import { allowsPlaintextPersistedSecret } from './policy'
export function save(p: string, apiToken: string) {
  if (!allowsPlaintextPersistedSecret()) { writeFileSync(p, apiToken) }
}`,
    writes: 1,
    gated: 0
  },
  {
    id: 'guard-in-a-sibling-branch-does-not-gate',
    source: `import { writeFileSync } from './disk'
import { allowsPlaintextPersistedSecret } from './policy'
export function save(p: string, apiToken: string) {
  if (allowsPlaintextPersistedSecret()) { void 0 }
  writeFileSync(p, apiToken)
}`,
    writes: 1,
    gated: 0
  },
  {
    id: 'guard-in-another-function-does-not-gate',
    source: `import { writeFileSync } from './disk'
import { allowsPlaintextPersistedSecret } from './policy'
function permitted() { return allowsPlaintextPersistedSecret() }
export function save(p: string, apiToken: string) {
  if (permitted()) { writeFileSync(p, apiToken) }
}`,
    writes: 1,
    gated: 0
  },
  {
    id: 'same-named-local-predicate-does-not-gate',
    source: `import { writeFileSync } from './disk'
function allowsPlaintextPersistedSecret() { return true }
export function save(p: string, apiToken: string) {
  if (allowsPlaintextPersistedSecret()) { writeFileSync(p, apiToken) }
}`,
    writes: 1,
    gated: 0
  },
  {
    // The shape that defeated the deleted property-callee name filter: the
    // property text is `saveIt`, the declaration it resolves to is named
    // `writeFileSync`. Any future filter keyed on callee text fails here.
    id: 'renamed-re-export-as-namespace-member',
    modules: {
      'renamed-barrel.ts': `export { writeFileSync as saveIt } from './disk'\n`
    },
    source: `import * as barrel from './renamed-barrel'
export function save(p: string, apiToken: string) { barrel.saveIt(p, apiToken) }`,
    writes: 1,
    gated: 0
  },
  {
    id: 'unsanctioned-predicate-does-not-gate',
    source: `import { writeFileSync } from './disk'
import { unrelatedFlag } from './policy'
export function save(p: string, apiToken: string) {
  if (unrelatedFlag()) { writeFileSync(p, apiToken) }
}`,
    writes: 1,
    gated: 0
  }
]

function callsIn(sourceFile) {
  const calls = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return calls.sort((a, b) => a.getStart() - b.getStart())
}

/** `{ failures, casesRun }`. `failures` is empty when the instrument is intact;
 *  the reporter must refuse to print anything when it is not. `casesRun` is
 *  returned rather than implied because an empty failure list from zero cases
 *  reads exactly like a clean instrument — the caller cross-checks it against
 *  CANARY_CASES.length, so silencing the canary needs two edits, not one.
 *
 *  All cases share one Program — each is its own module, so a local shadow in
 *  one cannot reach another, and building twenty Programs cost 7s for no extra
 *  isolation. */
export function calibrationFailures(cases = CASES) {
  const files = { 'disk.ts': DISK, 'policy.ts': POLICY }
  for (const testCase of cases) {
    files[`${testCase.id}.ts`] = testCase.source
    Object.assign(files, testCase.modules ?? {})
  }
  const project = createInMemoryProject(files)
  const sinks = buildSinkIndex(project, { seeds: SEEDS })
  const predicates = resolvePolicyPredicates(project, REGISTRY)
  const failures = []
  if (sinks.missingSeeds.length > 0) {
    failures.push('canary: the fixture write sink did not resolve')
  }
  if (predicates.missing.length > 0) {
    failures.push('canary: the fixture policy predicate did not resolve')
  }

  let casesRun = 0
  for (const testCase of cases) {
    let writes = 0
    let gated = 0
    const sourceFile = project.sourceFile(`${testCase.id}.ts`)
    if (!sourceFile) {
      failures.push(
        `${testCase.id}: the fixture module is not in the canary Program, so the case never ran`
      )
      continue
    }
    casesRun += 1
    for (const call of callsIn(sourceFile)) {
      const classified = classifyCall(sinks, call)
      if (!classified) {
        continue
      }
      if (secrecySignals(project, call, classified.sink).length === 0) {
        continue
      }
      writes += 1
      if (sanctionedGuardFor(project, call, predicates)) {
        gated += 1
      }
    }
    if (writes !== testCase.writes) {
      failures.push(
        `${testCase.id}: expected ${testCase.writes} secret write site(s), found ${writes}`
      )
    }
    if (gated !== testCase.gated) {
      failures.push(`${testCase.id}: expected ${testCase.gated} gated site(s), found ${gated}`)
    }
  }
  return { failures, casesRun }
}

export const CANARY_CASES = CASES
