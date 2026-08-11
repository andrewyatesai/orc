// @proves-gate-fires lint:switch-exhaustiveness
//
// This gate sits INSIDE the `lint` chain, so it really does block, but it was
// outside the coverage ledger's reach: GATES_MISSING_A_NEGATIVE_TEST is scoped to
// `check:`/`verify:` names, and this one is `lint:`. It was proved falsifiable by
// hand during a sweep and then had nothing pinning that down.
//
// It is also not a `config/scripts/*.mjs` gate — it is a raw oxlint invocation —
// so assertGateRejects (which spawns `node <script>`) does not fit. oxlint is
// spawned directly here, and the same two obligations are honoured explicitly:
// a positive control on the clean fixture, and a rejection message that names the
// planted violation rather than merely being non-zero.
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordLinterRejection } from './assert-gate-rejects-violation.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
// The identity gate-negative-coverage.test.mjs expects for this gate. It has no
// `node <script>` entry point, so the observed exit is recorded explicitly —
// otherwise the claim could only ever be settled by the tag comment.
const GATE_IDENTITY = 'oxlint:switch-exhaustiveness'
const OXLINT = path.join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')
const CONFIG = path.join(REPO_ROOT, 'config', 'oxlint-switch-exhaustiveness.json')
const sandboxes = []

/** Exactly the flags package.json's `lint:switch-exhaustiveness` passes. */
function runGate(dir) {
  try {
    const stdout = execFileSync(OXLINT, ['--type-aware', '--config', CONFIG, dir, '--quiet'], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    })
    return { status: 0, output: stdout }
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

async function createSandbox(switchBody) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-switch-exhaustiveness-'))
  sandboxes.push(root)
  await writeFile(
    path.join(root, 'mode.ts'),
    `export type Mode = 'classic' | 'alab' | 'story'\n\nexport function label(mode: Mode): string {\n${switchBody}\n}\n`
  )
  // A tsconfig is required: --type-aware needs the union's declared type to know
  // which arms are missing. Without it the rule cannot fire and every plant would
  // pass — the empty-scan failure this repo keeps producing.
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext' } })
  )
  return root
}

const EXHAUSTIVE = `  switch (mode) {
    case 'classic':
      return 'Classic'
    case 'alab':
      return 'ALab'
    case 'story':
      return 'Story World'
  }`

const MISSING_ARM = `  switch (mode) {
    case 'classic':
      return 'Classic'
    case 'alab':
      return 'ALab'
  }
  return ''`

const DEFAULT_CASE = `  switch (mode) {
    case 'classic':
      return 'Classic'
    default:
      return 'Other'
  }`

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('lint:switch-exhaustiveness rejects a switch that misses a union member', () => {
  it('accepts a switch covering every member', async () => {
    const root = await createSandbox(EXHAUSTIVE)
    const { status, output } = runGate(root)
    // Positive control. Without it, a fixture the linter cannot parse (or a
    // tsconfig it ignores) would make every planted violation "fail" for free.
    expect({ status, output }).toEqual({ status: 0, output: expect.any(String) })
  })

  it('EXITS NON-ZERO when an arm is missing, naming the rule', async () => {
    const root = await createSandbox(MISSING_ARM)
    const { status, output } = runGate(root)
    expect(status).not.toBe(0)
    expect(output).toContain('switch-exhaustiveness-check')
    // Names the member that is actually absent, not just "some switch is wrong".
    expect(output).toContain('story')
    recordLinterRejection(GATE_IDENTITY, status)
  })

  it('EXITS NON-ZERO for a default case, which is what allowDefaultCaseForExhaustiveSwitch:false buys', async () => {
    // A `default` arm silences the compiler while letting a new union member slip
    // through unhandled — the whole reason this gate is configured that way.
    const root = await createSandbox(DEFAULT_CASE)
    const { status, output } = runGate(root)
    expect(status).not.toBe(0)
    expect(output).toContain('switch-exhaustiveness-check')
    recordLinterRejection(GATE_IDENTITY, status)
  })
})
