// Negative test for the parity-corpus ratchet: `pnpm corpus:check`
// (tools/parity-corpus-metrics.mjs --check) and the `corpus` gauntlet axis that wraps it.
//
// Standalone on purpose. config/scripts/gate-negative-coverage.test.mjs enumerates gates by a
// `check:`/`verify:` name PREFIX and demands a config/scripts entry point, so `corpus:check` —
// suffix-named, living in tools/ — is invisible to it, and this file is the only thing that has
// ever watched the ratchet fail. It also pins the flagless arm (`pnpm corpus:metrics`) as a
// report: the same planted shrink leaves it at exit 0, by design.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertGateAccepts,
  assertGateRejects
} from '../config/scripts/assert-gate-rejects-violation.mjs'
import { corpusGate } from './terminal-bench/gauntlet-corpus.mjs'

const TOOL = 'parity-corpus-metrics.mjs'
const GATE_ARGS = ['--check'] // exactly what `pnpm corpus:check` passes
const VECTOR = 'tools/parity/vectors/dispatch-alpha.json'
const CORPUS = 'rust/crates/orca-example/parity-corpus.txt'
const BASELINE_VECTOR_CASES = 12
const BASELINE_CORPUS_CASES = 8

const vectorFile = (cases) =>
  `${JSON.stringify(
    {
      module: 'dispatch-alpha',
      source: 'src/shared/dispatch-alpha.ts',
      rustCrate: 'orca-dispatch',
      cases: Array.from({ length: cases }, (_, index) => ({
        input: `case-${index}`,
        expected: `out-${index}`
      }))
    },
    null,
    2
  )}\n`

// Comments and blanks are not cases, so a shrink has to be real to register.
const corpusFile = (cases) =>
  `# planted E1 oracle\n\n${Array.from({ length: cases }, (_, index) => `in-${index} => out-${index}`).join('\n')}\n`

const sandboxes = []

/**
 * A miniature repo the ratchet can measure end to end: its own copy of the tool, both corpus
 * families it discovers, and a baseline minted by the tool's own --write-baseline.
 */
async function createSandbox({ writeBaseline = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-parity-corpus-ratchet-')))
  sandboxes.push(root)
  await mkdir(path.join(root, 'tools', 'terminal-bench'), { recursive: true })
  await copyFile(path.join(import.meta.dirname, TOOL), path.join(root, 'tools', TOOL))

  const sandbox = {
    root,
    script: path.join(root, 'tools', TOOL),
    write: async (relativePath, contents) => {
      const target = path.join(root, ...relativePath.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, contents)
    },
    remove: (relativePath) => rm(path.join(root, ...relativePath.split('/')), { force: true }),
    cli: (args) => {
      const result = spawnSync(process.execPath, [sandbox.script, ...args], { encoding: 'utf8' })
      return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
    },
    accepts: () => assertGateAccepts({ script: sandbox.script, args: GATE_ARGS, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({
        script: sandbox.script,
        args: GATE_ARGS,
        cwd: root,
        violation,
        expectMessage
      }),
    // The gauntlet axis reads this tool through an injected repo root and `sh`.
    axis: () =>
      corpusGate({
        repo: root,
        sh: (cmd, args) =>
          execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      })
  }

  await sandbox.write(VECTOR, vectorFile(BASELINE_VECTOR_CASES))
  await sandbox.write(CORPUS, corpusFile(BASELINE_CORPUS_CASES))
  if (writeBaseline) {
    const minted = sandbox.cli(['--write-baseline'])
    expect(minted.status).toBe(0)
    expect(minted.output).toContain(`"totalCases":${BASELINE_VECTOR_CASES + BASELINE_CORPUS_CASES}`)
  }
  return sandbox
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('corpus:check rejects parity-coverage regressions', () => {
  it('fails when an E1 shared corpus loses cases', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.write(CORPUS, corpusFile(BASELINE_CORPUS_CASES - 3))

    sandbox.rejects(
      'an E1 oracle three cases shorter than the baseline recorded',
      `e1SharedCases: ${BASELINE_CORPUS_CASES - 3} < baseline ${BASELINE_CORPUS_CASES}`
    )
  })

  it('fails when a dispatch-parity vector module is deleted outright', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.remove(VECTOR)

    const output = sandbox.rejects(
      'a whole dispatch-parity vector module removed',
      `dispatchParityCases: 0 < baseline ${BASELINE_VECTOR_CASES}`
    )
    expect(output).toContain('parity coverage shrank')
  })

  it('never reads a missing baseline as proof — exit 3, and the axis asks for one', async () => {
    // The repo's recurring failure mode: a gate that measured nothing and exited 0.
    const sandbox = await createSandbox({ writeBaseline: false })

    const { status, output } = sandbox.cli(GATE_ARGS)
    expect(status).toBe(3)
    expect(output).toContain('--write-baseline')
    expect(sandbox.axis().status).toBe('REVIEW')
  })
})

describe('the corpus gauntlet axis carries the ratchet verdict', () => {
  it('turns a shrunk corpus into FAIL rather than swallowing the exit', async () => {
    const sandbox = await createSandbox()
    expect(sandbox.axis().status).toBe('PASS')

    await sandbox.write(CORPUS, corpusFile(0))

    const failed = sandbox.axis()
    expect(failed.status).toBe('FAIL')
    expect(failed.detail).toContain('parity coverage SHRANK')
    expect(failed.metrics.e1SharedCases).toBe(0)
  })
})

describe('corpus:metrics is a report, not the gate', () => {
  it('still exits 0 on the shrink its --check twin rejects', async () => {
    const sandbox = await createSandbox()
    await sandbox.write(CORPUS, corpusFile(0))
    sandbox.rejects('an emptied E1 oracle', `e1SharedCases: 0 < baseline ${BASELINE_CORPUS_CASES}`)

    const report = sandbox.cli([])
    expect(report.status).toBe(0)
    expect(report.output).toContain(`TOTAL: ${BASELINE_VECTOR_CASES} cases`)
  })
})
