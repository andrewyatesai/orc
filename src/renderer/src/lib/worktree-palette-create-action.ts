import { isWorktreePaletteQueryTooLarge } from './worktree-palette-query-bounds'

export const CREATE_WORKTREE_ITEM_ID = '__create_worktree__'

export type WorktreePaletteCreateActionState = {
  createWorktreeName: string
  showCreateAction: boolean
}

export function getWorktreePaletteCreateActionState({
  query
}: {
  query: string
}): WorktreePaletteCreateActionState {
  const createWorktreeName = query.trim()
  if (isWorktreePaletteQueryTooLarge(createWorktreeName)) {
    return {
      createWorktreeName: '',
      showCreateAction: false
    }
  }
  // Why no project gate: the composer can add the first project inline, so
  // creation stays offered with zero projects.
  const showCreateAction = createWorktreeName.length > 0
  return {
    createWorktreeName,
    showCreateAction
  }
}

type WorktreePaletteSelectionCandidateEntry = {
  id: string
  type: string
}

// Why every rendered CommandItem type belongs here: an id missing from this list fails the
// `includes` check in getNextWorktreePaletteSelection, so arrowing onto that row snaps the
// highlight back to the top — making the whole section mouse-only.
const SELECTABLE_ENTRY_TYPES = [
  'worktree',
  'create-worktree',
  'settings',
  'quick-action',
  'browser-page',
  'workspace-tab',
  'simulator-tab',
  'project-target'
] as const

type WorktreePaletteSelectableEntryType = (typeof SELECTABLE_ENTRY_TYPES)[number]

const SELECTABLE_ENTRY_TYPE_SET = new Set<string>(SELECTABLE_ENTRY_TYPES)

export function isSelectableWorktreePaletteEntry(
  entry: WorktreePaletteSelectionCandidateEntry
): entry is WorktreePaletteSelectionCandidateEntry & {
  type: WorktreePaletteSelectableEntryType
} {
  return SELECTABLE_ENTRY_TYPE_SET.has(entry.type)
}

export function getWorktreePaletteSelectionItemIds<
  T extends WorktreePaletteSelectionCandidateEntry
>(entries: readonly T[], renderKeys: readonly string[] = []): string[] {
  // Why: keyboard focus should mirror rendered order, including synthetic
  // action rows, while skipping headers and explanatory hint rows.
  // Why renderKeys wins: rows render under de-duplicated keys, so naming the bare
  // id here would leave a duplicate row absent from the list the `includes` check
  // above consults — arrowing onto it would snap the highlight back to the top.
  return entries
    .map((entry, index) => ({ entry, id: renderKeys[index] ?? entry.id }))
    .filter(({ entry }) => isSelectableWorktreePaletteEntry(entry))
    .map(({ id }) => id)
}

export function getNextWorktreePaletteSelection({
  currentSelectedItemId,
  queryChanged,
  selectableItemIds,
  showCreateAction
}: {
  currentSelectedItemId: string
  queryChanged: boolean
  selectableItemIds: readonly string[]
  showCreateAction: boolean
}): string {
  const firstSelectableId = selectableItemIds[0] ?? null

  if (queryChanged) {
    return firstSelectableId ?? (showCreateAction ? CREATE_WORKTREE_ITEM_ID : '')
  }

  if (currentSelectedItemId === CREATE_WORKTREE_ITEM_ID && showCreateAction) {
    return currentSelectedItemId
  }

  if (selectableItemIds.includes(currentSelectedItemId)) {
    return currentSelectedItemId
  }

  return firstSelectableId ?? (showCreateAction ? CREATE_WORKTREE_ITEM_ID : '')
}

export type WorktreePaletteRequestGuard = {
  start: () => number
  invalidate: () => void
  isCurrent: (token: number) => boolean
}

export function createWorktreePaletteRequestGuard(): WorktreePaletteRequestGuard {
  let currentToken = 0

  return {
    start: () => {
      currentToken += 1
      return currentToken
    },
    invalidate: () => {
      currentToken += 1
    },
    isCurrent: (token: number) => token === currentToken
  }
}
