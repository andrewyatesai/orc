import type { SkillFreshnessGroupModel } from './skill-freshness-grouping'
import type { SkillRowState } from './SkillUpdateRow'

export type SkillUpdateRowModel = { group: SkillFreshnessGroupModel; state: SkillRowState }

/**
 * One row list for every state, across both update rails.
 *
 * The rows are identical objects through the transition, so pressing Update changes
 * each row's leading icon in place instead of swapping the dialog's body for a
 * different component. A name being written offline reads exactly like one the npx
 * runner owns — the user pressed one button, so it must look like one operation.
 */
export function skillUpdateRowStates(args: {
  groups: readonly SkillFreshnessGroupModel[]
  runNames: readonly string[]
  isRunning: boolean
  failedNames: readonly string[]
  offlineNames: readonly string[]
  isInstallingOffline: boolean
  offlineFailedNames: readonly string[]
}): SkillUpdateRowModel[] {
  const inRun = new Set(args.runNames)
  const failed = new Set(args.failedNames)
  const inOfflineRun = new Set(args.offlineNames)
  const offlineFailed = new Set(args.offlineFailedNames)
  const settled = (name: string, failures: Set<string>): SkillRowState =>
    failures.has(name) ? 'failed' : 'done'

  return args.groups.map((group) => {
    if (inOfflineRun.has(group.name)) {
      return {
        group,
        state: args.isInstallingOffline ? 'pending' : settled(group.name, offlineFailed)
      }
    }
    if (inRun.has(group.name)) {
      return { group, state: args.isRunning ? 'pending' : settled(group.name, failed) }
    }
    return { group, state: group.status === 'cannot-update' ? 'blocked' : 'available' }
  })
}
