import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { GitBranch, Server } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepoMap, useWorktreeMap } from '@/store/selectors'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { branchDisplayName } from './WorktreeCardHelpers'
import { WorktreeActivityStatusIndicator } from './WorktreeActivityStatusIndicator'
import { getEligibleWorktreeParents } from './worktree-parent-candidates'
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../shared/types'

type WorktreeParentPickerPopoverProps = {
  open: boolean
  childWorktreeId: string | null
  anchorElement: HTMLElement | null
  onOpenChange: (open: boolean) => void
}

type AnchorRect = Pick<DOMRect, 'height' | 'left' | 'top' | 'width'>

type SelectParentArgs = {
  childWorktreeId: string | null
  parentWorktreeId: string
  assignWorktreeParent: (worktreeId: string, args: { parentWorktreeId: string }) => Promise<void>
  close: () => void
  showError: (message: string) => void
}

function getAnchorRect(anchorElement: HTMLElement | null): AnchorRect | null {
  return anchorElement?.getBoundingClientRect() ?? null
}

const FOCUSABLE_ANCHOR_SELECTOR =
  'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'

// Why: the anchor is a non-focusable worktree row, so closing focus has to land
// on its nearest focusable container (the sidebar listbox), not document.body.
export function getWorktreeParentPickerFocusRestoreTarget(
  anchorElement: HTMLElement | null
): HTMLElement | null {
  if (!anchorElement?.isConnected) {
    return null
  }
  return anchorElement.closest<HTMLElement>(FOCUSABLE_ANCHOR_SELECTOR)
}

export function getWorktreeParentPickerItemValue(candidate: Worktree): string {
  return `${candidate.displayName} ${branchDisplayName(candidate.branch)} ${candidate.path}`
}

export function selectWorktreeParent({
  childWorktreeId,
  parentWorktreeId,
  assignWorktreeParent,
  close,
  showError
}: SelectParentArgs): void {
  if (!childWorktreeId) {
    return
  }
  close()
  void assignWorktreeParent(childWorktreeId, { parentWorktreeId }).catch((error) => {
    console.error('Failed to set parent worktree:', error)
    showError(
      translate(
        'auto.components.sidebar.WorktreeParentPickerPopover.failedSetParent',
        'Failed to set parent worktree'
      )
    )
  })
}

function WorktreeParentPickerRow({
  candidate,
  isCurrent
}: {
  candidate: Worktree
  isCurrent: boolean
}): React.JSX.Element {
  const repo = useRepoMap().get(candidate.repoId)
  const branch = branchDisplayName(candidate.branch)

  return (
    <div className="flex min-w-0 flex-1 items-start gap-2">
      <WorktreeActivityStatusIndicator worktreeId={candidate.id} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{candidate.displayName}</span>
          {isCurrent ? (
            <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-px text-[9px] font-medium leading-none text-muted-foreground">
              {translate('auto.components.sidebar.WorktreeParentPickerPopover.current', 'Current')}
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
          {repo ? (
            <span className="inline-flex min-w-0 max-w-[8rem] shrink-0 items-center gap-1 rounded border border-border bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
              <RepoBadgeMark color={repo.badgeColor} />
              <span className="truncate lowercase">{repo.displayName}</span>
            </span>
          ) : null}
          {repo?.connectionId ? <Server className="size-3 shrink-0" /> : null}
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </div>
      </div>
    </div>
  )
}

export function WorktreeParentPickerPopover({
  open,
  childWorktreeId,
  anchorElement,
  onOpenChange
}: WorktreeParentPickerPopoverProps): React.JSX.Element | null {
  const worktrees = useAllWorktrees()
  const worktreeMap = useWorktreeMap()
  const repoMap = useRepoMap()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const lineageById = useAppStore((s) => s.worktreeLineageById)
  const assignWorktreeParent = useAppStore((s) => s.assignWorktreeParent)
  const suppressInitialOutsideCloseRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [anchorRect, setAnchorRect] = useState<AnchorRect | null>(() =>
    getAnchorRect(anchorElement)
  )
  const child = childWorktreeId ? worktreeMap.get(childWorktreeId) : undefined
  const candidates = useMemo(
    () =>
      child
        ? getEligibleWorktreeParents({
            child,
            worktrees,
            lineageById,
            worktreeMap,
            repoMap
          })
        : [],
    [child, lineageById, repoMap, worktreeMap, worktrees]
  )

  useLayoutEffect(() => {
    if (!open) {
      return
    }
    const updateAnchorRect = (): void => setAnchorRect(getAnchorRect(anchorElement))
    updateAnchorRect()
    window.addEventListener('resize', updateAnchorRect)
    window.addEventListener('scroll', updateAnchorRect, true)
    return () => {
      window.removeEventListener('resize', updateAnchorRect)
      window.removeEventListener('scroll', updateAnchorRect, true)
    }
  }, [anchorElement, open])

  useEffect(() => {
    if (!open) {
      suppressInitialOutsideCloseRef.current = false
      return
    }
    suppressInitialOutsideCloseRef.current = true
    // Why: the click that selected the dropdown item can reach Radix's newly
    // mounted popover as an outside interaction before the picker settles.
    const timerId = window.setTimeout(() => {
      suppressInitialOutsideCloseRef.current = false
    }, 150)
    return () => window.clearTimeout(timerId)
  }, [open])

  const handleSelect = useCallback(
    (parentWorktreeId: string) => {
      selectWorktreeParent({
        childWorktreeId,
        parentWorktreeId,
        assignWorktreeParent,
        close: () => onOpenChange(false),
        showError: toast.error
      })
    },
    [assignWorktreeParent, childWorktreeId, onOpenChange]
  )

  if (!child || !anchorRect) {
    return null
  }

  return (
    // Why: modal traps focus (incl. post-menu aterm restore); non-modal loses search focus.
    <Popover modal open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed"
          style={{
            left: anchorRect.left,
            top: anchorRect.top,
            width: anchorRect.width,
            height: anchorRect.height
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="right"
        sideOffset={8}
        className="w-80 p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
        // Why: the hidden anchor span is no valid focus target for Radix to
        // restore to, so drive focus back to the anchored row's listbox instead
        // of dropping it on the detached input (i.e. document.body).
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          getWorktreeParentPickerFocusRestoreTarget(anchorElement)?.focus()
        }}
        onInteractOutside={(event) => {
          if (suppressInitialOutsideCloseRef.current) {
            event.preventDefault()
          }
        }}
      >
        <Command>
          <CommandInput
            ref={inputRef}
            placeholder={translate(
              'auto.components.sidebar.WorktreeParentPickerPopover.searchPlaceholder',
              'Search worktrees...'
            )}
          />
          <CommandList className="max-h-72">
            <CommandEmpty>
              {translate(
                'auto.components.sidebar.WorktreeParentPickerPopover.empty',
                'No matching eligible worktrees.'
              )}
            </CommandEmpty>
            {candidates.map((candidate) => (
              <CommandItem
                key={candidate.id}
                value={getWorktreeParentPickerItemValue(candidate)}
                onSelect={() => handleSelect(candidate.id)}
                className="items-start px-2 py-2"
              >
                <WorktreeParentPickerRow
                  candidate={candidate}
                  isCurrent={activeWorktreeId === candidate.id}
                />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
