// @proves-gate-fires check:reliability-gates
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_SCRIPT = 'check-reliability-gates.mjs'
const MANIFEST_PATH = path.join('config', 'reliability-gates.jsonc')
const GATE_ID = 'terminal-session.snapshot-freshness'
// Manifest paths are POSIX-form in the file and echoed verbatim in the failure text.
const TEST_FILE = 'src/renderer/terminal-snapshot-freshness.test.ts'
const COMMAND = `pnpm exec vitest run --config config/vitest.config.ts ${TEST_FILE}`
const sandboxes = []

// pnpm keeps the package under .pnpm/<name>@<version>/node_modules/<name>, so walk the
// resolved entry point back to the directory the sandbox can link as a bare specifier.
function packageRoot(name) {
  let dir = path.dirname(createRequire(import.meta.url).resolve(name))
  while (path.basename(dir) !== name) {
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(`Could not locate the ${name} package root`)
    }
    dir = parent
  }
  return dir
}

function baseManifest() {
  return {
    schemaVersion: 1,
    updatedAt: '2026-07-26',
    policy: {
      maturityLevels: ['experimental', 'soak', 'blocking', 'accepted-gap', 'deprecated'],
      blockingPromotion: { minimumSoakRuns: 100, minimumSoakDays: 14, maximumUnexplainedFlakes: 0 }
    },
    gates: [
      {
        id: GATE_ID,
        title: 'Stale liveness snapshots cannot close newer PTY bindings',
        maturity: 'soak',
        protection: 'partial',
        owner: 'terminal-runtime',
        layer: 'renderer-unit',
        surfaces: ['terminal lifecycle'],
        platforms: ['macos', 'linux', 'windows'],
        providers: ['local', 'daemon'],
        coveredPlatforms: ['macos'],
        coveredProviders: ['local'],
        coverageNotes: 'One local macOS unit run covers the local decision layer only.',
        motivatingLinks: ['internal regression: a stale snapshot closed a live pane'],
        invariant: 'A stale snapshot cannot close a newer binding.',
        oracle: 'The test rejects reconciliation when the binding is newer than the snapshot.',
        commands: [COMMAND],
        testFiles: [TEST_FILE],
        assertionRefs: [
          {
            file: TEST_FILE,
            assertions: ['stale liveness snapshots do not close newer PTY bindings']
          }
        ],
        evidenceRuns: [
          {
            date: '2026-07-02',
            runner: 'local',
            platform: 'macos',
            command: COMMAND,
            result: 'passed',
            durationSeconds: 1.2,
            summary: '1 file passed.'
          }
        ],
        runtimeBudget: { p95Seconds: 10, scope: 'one focused renderer unit file' },
        flakeHistory: { status: 'soaking', evidence: 'Soak history exists.' },
        redGreenEvidence: {
          status: 'complete',
          evidence: 'Fails when the guard is removed and passes with the fix.'
        },
        performanceBudget: {
          required: true,
          evidence: 'Perf measurement is required before blocking promotion.'
        },
        promotionCriteria: ['Collect soak history.'],
        knownGaps: ['Needs an Electron survival test.'],
        demotionRule: 'Demote on unexplained flakes.'
      }
    ]
  }
}

// A fake repo root holding only what the gate reads: the manifest, the test files it
// declares, and a link for its one runtime dependency.
async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-reliability-gates-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await mkdir(path.join(root, 'node_modules'), { recursive: true })
  await copyFile(path.join(import.meta.dirname, GATE_SCRIPT), path.join(scriptDir, GATE_SCRIPT))
  await symlink(
    packageRoot('jsonc-parser'),
    path.join(root, 'node_modules', 'jsonc-parser'),
    'junction'
  )

  const sandbox = {
    root,
    script: path.join(scriptDir, GATE_SCRIPT),
    manifest: baseManifest(),
    write: async () => {
      await writeFile(
        path.join(root, MANIFEST_PATH),
        `// Reliability gate manifest fixture.\n${JSON.stringify(sandbox.manifest, null, 2)}\n`
      )
      for (const gate of sandbox.manifest.gates) {
        for (const testFile of gate.testFiles ?? []) {
          const target = path.join(root, testFile)
          await mkdir(path.dirname(target), { recursive: true })
          await writeFile(target, '')
        }
      }
    },
    accepts: () => assertGateAccepts({ script: sandbox.script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: sandbox.script, cwd: root, violation, expectMessage })
  }
  await sandbox.write()
  return sandbox
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:reliability-gates rejects a gate that stops being wired', () => {
  it('fails when a declared gate loses the test file it points at', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await rm(path.join(sandbox.root, TEST_FILE))

    sandbox.rejects(
      'a declared gate whose test file was deleted or renamed',
      `${GATE_ID}: test file does not exist: ${TEST_FILE}`
    )
  })

  it('fails when no gate command runs the declared test file any more', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    // The record still claims the file; the command that would execute it now runs
    // something else — the silent-disable shape.
    const disabled =
      'pnpm exec vitest run --config config/vitest.config.ts src/renderer/other.test.ts'
    const [gate] = sandbox.manifest.gates
    gate.commands = [disabled]
    gate.evidenceRuns[0].command = disabled
    await sandbox.write()

    sandbox.rejects(
      'a declared gate no command executes',
      `${GATE_ID}: test file is not referenced by any gate command: ${TEST_FILE}`
    )
  })

  it('fails when the declared gate set is emptied', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    sandbox.manifest.gates = []
    await sandbox.write()

    sandbox.rejects('a manifest with every gate removed', 'gates must be a non-empty array')
  })
})
