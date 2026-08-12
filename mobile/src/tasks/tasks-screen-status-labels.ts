/**
 * The provider status vocabulary the tasks screen renders.
 *
 * Extracted from tasks.tsx, which sits under a bespoke max-lines ceiling that
 * upstream work had grown one line past. These four were the natural unit: pure
 * string mappers with no styles, no state and no host access.
 *
 * They take STRUCTURAL parameters rather than the screen's row types, so the
 * vocabulary does not depend on the screen — GitHub and GitLab each spell the
 * same four outcomes differently, and that translation is what these encode.
 */

/** GitHub Projects rows carry the draft/redacted distinction outside `state`. */
export function projectRowStatusLabel(row: {
  itemType: string
  // Nullable rather than optional: the GraphQL rows carry explicit nulls.
  content: { isDraft?: boolean | null; state?: string | null }
}): string {
  if (row.itemType === 'DRAFT_ISSUE') {
    return 'Draft'
  }
  if (row.itemType === 'REDACTED') {
    return 'Redacted'
  }
  if (row.content.isDraft) {
    return 'Draft'
  }
  if (row.content.state === 'MERGED') {
    return 'Merged'
  }
  if (row.content.state === 'CLOSED') {
    return 'Closed'
  }
  return 'Open'
}

export function gitHubStatusLabel(item: { state: string }): string {
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'draft') {
    return 'Draft'
  }
  return item.state === 'closed' ? 'Closed' : 'Open'
}

/** GitLab's default is `Locked`, not `Open` — the one asymmetry with GitHub. */
export function gitLabStatusLabel(item: { state: string }): string {
  if (item.state === 'opened') {
    return 'Open'
  }
  if (item.state === 'merged') {
    return 'Merged'
  }
  if (item.state === 'draft') {
    return 'Draft'
  }
  return item.state === 'closed' ? 'Closed' : 'Locked'
}

export function gitLabTodoTargetLabel(todo: { targetType: string }): string {
  if (todo.targetType === 'MergeRequest') {
    return 'Merge request'
  }
  if (todo.targetType === 'Issue') {
    return 'Issue'
  }
  return 'GitLab todo'
}
