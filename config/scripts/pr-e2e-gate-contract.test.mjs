import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
// Why: the fork runs no hosted CI, so these workflows are dropped — gate on the asserted
// files so the contract runs wherever they ship and skips cleanly where they do not.
const HAS_CI_PR_WORKFLOWS =
  existsSync(join(projectDir, '.github/workflows/pr.yml')) &&
  existsSync(join(projectDir, '.github/workflows/e2e.yml'))

function readWorkflow(name) {
  return parse(readFileSync(join(projectDir, '.github/workflows', name), 'utf8'))
}

function readPrSteps() {
  const prWorkflow = readWorkflow('pr.yml')
  return {
    prWorkflow,
    filterStep: prWorkflow.jobs['e2e-paths'].steps.find(
      (step) => step.name === 'Filter changed E2E specs'
    ),
    verifyStep: prWorkflow.jobs.verify.steps.find(
      (step) => step.name === 'Require successful checks'
    )
  }
}

describe('PR E2E gate contract', () => {
  it.skipIf(!HAS_CI_PR_WORKFLOWS)('keeps E2E advisory while the suite is red on main', () => {
    // Why: pin the deliberate choice so it reads as intentional rather than as
    // the "forgot to wire the gate" bug this file originally caught. Gating on a
    // suite that fails every scheduled run would block the PRs that fix it.
    // Flipping to blocking means updating this expectation too — see the comment
    // on verify's Require-successful-checks step for the exact wiring.
    const { prWorkflow, verifyStep } = readPrSteps()

    expect(prWorkflow.jobs.verify.needs).not.toContain('e2e')
    expect(verifyStep.env.E2E).toBeUndefined()
    expect(verifyStep.run).not.toContain('$E2E')
  })

  it.skipIf(!HAS_CI_PR_WORKFLOWS)('passes only changed specs to the reusable E2E workflow', () => {
    // Why: without this the job could lose its filter and run on every PR — the
    // cost the path filter exists to avoid — while the gate assertions above
    // stay green.
    const { prWorkflow } = readPrSteps()

    expect(prWorkflow.jobs.e2e.needs).toBe('e2e-paths')
    expect(prWorkflow.jobs.e2e.if).toBe("needs.e2e-paths.outputs.should_run == 'true'")
    expect(prWorkflow.jobs['e2e-paths'].outputs.should_run).toBe(
      '${{ steps.filter.outputs.should_run }}'
    )
    expect(prWorkflow.jobs['e2e-paths'].outputs.test_files).toBe(
      '${{ steps.filter.outputs.test_files }}'
    )
    expect(prWorkflow.jobs.e2e.with.test_files).toBe('${{ needs.e2e-paths.outputs.test_files }}')
  })

  it.skipIf(!HAS_CI_PR_WORKFLOWS)('enforces every job verify depends on', () => {
    // Why: derive from verify.needs rather than hardcoding, so adding a required
    // job without adding it to the strict loop fails here instead of silently
    // leaving that job unenforced. This is what caught GIT_COMPATIBILITY and
    // SHELL_CONTRACTS being absent from an earlier hardcoded list.
    const { prWorkflow, verifyStep } = readPrSteps()
    const strictLoop = verifyStep.run.slice(0, verifyStep.run.indexOf('done'))

    for (const job of prWorkflow.jobs.verify.needs) {
      const envVar = job.toUpperCase()
      expect(verifyStep.env[envVar]).toBe(`\${{ needs.${job}.result }}`)
      expect(strictLoop).toContain(`"$${envVar}"`)
    }
  })

  it.skipIf(!HAS_CI_PR_WORKFLOWS)(
    'selects modified Playwright specs without running deleted tests',
    () => {
      const { filterStep } = readPrSteps()

      expect(filterStep.run).toContain('--diff-filter=AMCR')
      expect(filterStep.run).toContain("'^tests/e2e/.*\\.spec\\.ts$'")
      expect(filterStep.run).not.toContain('tests/playwright\\.')
    }
  )

  it.skipIf(!HAS_CI_PR_WORKFLOWS)(
    'uses one runner for changed specs and keeps full runs sharded',
    () => {
      const e2eWorkflow = readWorkflow('e2e.yml')

      expect(e2eWorkflow.jobs.e2e.if).toBe("inputs.test_files == ''")
      expect(e2eWorkflow.jobs['changed-e2e'].if).toBe("inputs.test_files != ''")
      expect(e2eWorkflow.jobs['changed-e2e'].strategy).toBeUndefined()
      expect(e2eWorkflow.jobs['ssh-docker-watcher-isolation'].if).toBe("inputs.test_files == ''")
      const changedRun = e2eWorkflow.jobs['changed-e2e'].steps.find(
        (step) => step.name === 'Run changed E2E specs'
      )
      expect(changedRun.env.TEST_FILES_JSON).toBe('${{ inputs.test_files }}')
      expect(changedRun.run).toContain('pnpm run test:e2e "${TEST_FILES[@]}" --workers=1')
    }
  )

  it.skipIf(!HAS_CI_PR_WORKFLOWS)('keeps dedicated E2E workflows out of pull request CI', () => {
    const dedicatedWorkflows = [
      'golden-e2e-experiment.yml',
      'linux-wayland-gpu-sandbox.yml',
      'terminal-ime-e2e.yml',
      'win-crash-survival-e2e.yml',
      'windows-terminal-restart-e2e.yml'
    ]

    for (const file of dedicatedWorkflows) {
      expect(readWorkflow(file).on.pull_request, file).toBeUndefined()
    }
  })

  it.skipIf(!HAS_CI_PR_WORKFLOWS)(
    'scopes detection to the PR range so base drift cannot false-trigger',
    () => {
      const { filterStep } = readPrSteps()

      expect(filterStep.run).toContain('--merge-base "$BASE" "$HEAD"')
      expect(filterStep.run).toContain('set -euo pipefail')
    }
  )
})
