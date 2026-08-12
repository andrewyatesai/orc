import { getLinearIssueWorkspaceName } from '@/lib/git-wasm/workspace-name'
import type { LinearIssue } from '../../../shared/types'
import { getUsableLinearBranchName } from '../../../shared/new-workspace/workspace-source'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'

export function formatLinearIssueRelativeTime(input: string): string {
  return formatUiRelativeTimeFromDate(input)
}

export function buildLinearIssueBranchName(issue: LinearIssue): string {
  return getUsableLinearBranchName(issue.branchName) ?? getLinearIssueWorkspaceName(issue)
}

export function buildLinearIssuePrompt(issue: LinearIssue): string {
  const lines = [
    `Linear issue: ${issue.identifier} ${issue.title}`,
    `URL: ${issue.url}`,
    `State: ${issue.state.name}`,
    `Assignee: ${issue.assignee?.displayName ?? 'Unassigned'}`,
    `Team: ${issue.team.name}`
  ]
  if (issue.workspaceName) {
    lines.push(`Workspace: ${issue.workspaceName}`)
  }
  const description = issue.description?.trim()
  if (description) {
    lines.push('', 'Description:', description)
  }
  return lines.join('\n')
}
