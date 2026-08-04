import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// Why: the fork runs no hosted CI, so pr.yml is dropped — gate on the asserted
// file so the contract runs wherever it ships and skips cleanly where it does not.
const HAS_CI_PR_WORKFLOW = existsSync('.github/workflows/pr.yml')

describe('packaged skills CLI PR gates', () => {
  it.skipIf(!HAS_CI_PR_WORKFLOW)('builds and executes the Windows packaged CLI', () => {
    const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
    const job = workflow.jobs.package_windows
    const buildStep = job.steps.find((step) => step.name === 'Build package inputs')
    const prepareStep = job.steps.find((step) => step.name === 'Prepare Electron native runtime')
    const packageStep = job.steps.find((step) => step.name === 'Package unpacked app')
    const smokeStep = job.steps.find((step) => step.name === 'Smoke packaged CLI')

    expect(job['runs-on']).toBe('windows-2022')
    expect(buildStep.run).toBe('pnpm run build:release')
    expect(prepareStep.run).toBe('node config/scripts/ensure-native-runtime.mjs --runtime=electron')
    expect(packageStep.run).toContain('electron-builder')
    expect(packageStep.run).toContain('--dir')
    expect(packageStep.env.ORCA_REUSE_PREPARED_NATIVE_RUNTIME).toBe('1')
    expect(smokeStep.run).toBe(
      'node config/scripts/smoke-packaged-cli.mjs --app-dir=dist/win-unpacked'
    )

    const aggregateStep = workflow.jobs.verify.steps.find(
      (step) => step.name === 'Require successful checks'
    )
    expect(aggregateStep.env.PACKAGE_WINDOWS).toBe('${{ needs.package_windows.result }}')
    expect(aggregateStep.run).toContain('"$PACKAGE_WINDOWS"')
  })
})
