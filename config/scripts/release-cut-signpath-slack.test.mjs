import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
// Why: the fork runs no hosted CI, so release-cut.yml is dropped — gate on the asserted
// file so the contract runs wherever it ships and skips cleanly where it does not.
const HAS_CI_RELEASE_CUT_WORKFLOW = existsSync(
  join(projectDir, '.github/workflows/release-cut.yml')
)

describe('release-cut SignPath Slack approval pings', () => {
  it.skipIf(!HAS_CI_RELEASE_CUT_WORKFLOW)(
    'includes cut source ref/commit and who triggered the cut',
    () => {
      const workflow = parse(
        readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
      )

      const cutOutputs = workflow.jobs.cut.outputs
      expect(cutOutputs.source_ref).toContain('steps.resolve.outputs.ref')
      expect(cutOutputs.source_sha).toContain('steps.resolve.outputs.sha')
      expect(cutOutputs.source_short_sha).toContain('steps.resolve.outputs.short_sha')

      const steps = workflow.jobs.build.steps
      const notifySteps = steps.filter(
        (step) =>
          step.name === 'Notify Slack that inner-binary signing is waiting for approval' ||
          step.name === 'Notify Slack that Windows signing is waiting for approval'
      )
      expect(notifySteps).toHaveLength(2)

      for (const step of notifySteps) {
        expect(step.env.SOURCE_REF).toContain('needs.cut.outputs.source_ref')
        expect(step.env.SOURCE_SHA).toContain('needs.cut.outputs.source_sha')
        expect(step.env.SOURCE_SHORT_SHA).toContain('needs.cut.outputs.source_short_sha')
        expect(step.env.CUT_BY).toMatch(/github\.(triggering_actor|actor)/)
        expect(step.run).toContain('Source:')
        expect(step.run).toContain('cut by')
      }
    }
  )
})
