import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The claim a negative test writes so `gate-negative-coverage.test.mjs` can pair it
 * with a package.json gate: `// @proves-gate-fires check:aterm-pin`.
 */
export const GATE_COVERAGE_TAG = '@proves-gate-fires'

/**
 * File the coverage meta-test points us at so a claim is settled by execution.
 *
 * A tag is a comment and `assertGateRejects(` is a substring; neither proves the gate
 * ran. Only a rejection this function actually observed appends a line here.
 */
export const GATE_COVERAGE_LEDGER_ENV = 'ORCA_GATE_COVERAGE_LEDGER'

function recordRejection(script, status) {
  const ledger = process.env[GATE_COVERAGE_LEDGER_ENV]
  if (!ledger) {
    return
  }
  // Sandboxes run a copy of the shipped script, so the basename is the identity that survives.
  appendFileSync(ledger, `${JSON.stringify({ script: path.basename(script), status })}\n`)
}

function runGate({ script, args = [], cwd }) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' }
  })
  if (result.error) {
    throw new Error(`Could not run ${script}: ${result.error.message}`)
  }
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/**
 * Positive control: the gate must pass on the untouched fixture.
 *
 * Without it a fixture that is broken for an unrelated reason makes every planted
 * violation "fail" for free — a green negative test that proves nothing.
 */
export function assertGateAccepts({ script, args, cwd }) {
  const { status, output } = runGate({ script, args, cwd })
  if (status !== 0) {
    throw new Error(`Gate rejected its own clean fixture (exit ${status}):\n${output}`)
  }
  return output
}

/** The gate must exit non-zero, and say so because of `violation`, not incidentally. */
export function assertGateRejects({ script, args, cwd, violation, expectMessage }) {
  if (!violation || !expectMessage) {
    throw new Error('A negative test must name its planted violation and the expected message.')
  }
  const { status, output } = runGate({ script, args, cwd })
  if (status === 0) {
    throw new Error(`Gate accepted a planted violation (${violation}):\n${output}`)
  }
  if (!output.includes(expectMessage)) {
    throw new Error(
      `Gate rejected ${violation} but never reported it — expected ${JSON.stringify(expectMessage)} in:\n${output}`
    )
  }
  recordRejection(script, status)
  return output
}
