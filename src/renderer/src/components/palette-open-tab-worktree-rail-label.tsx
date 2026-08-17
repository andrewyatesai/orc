import React, { useLayoutEffect, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeBranchLabel } from '@/lib/worktree-default-display-name'
import type { MatchRange } from '@/lib/worktree-palette-search'
import type { Worktree } from '../../../shared/types'

function HighlightedRailText({
  text,
  matchRange
}: {
  text: string
  matchRange: MatchRange | null
}): React.JSX.Element {
  if (!matchRange) {
    return <>{text}</>
  }
  const before = text.slice(0, matchRange.start)
  const match = text.slice(matchRange.start, matchRange.end)
  const after = text.slice(matchRange.end)
  return (
    <>
      {before}
      <span className="font-semibold text-foreground">{match}</span>
      {after}
    </>
  )
}

export function resolveOpenTabWorktreeRailTooltip({
  isBranch,
  truncated,
  name
}: {
  isBranch: boolean
  truncated: boolean
  name: string
}): string {
  if (truncated) {
    return name
  }
  return isBranch
    ? translate('auto.components.WorktreeJumpPalette.paletteOpenTabBranch', 'Branch name')
    : translate('auto.components.WorktreeJumpPalette.paletteOpenTabWorkspace', 'Workspace name')
}

// Worktree/branch label that lives in the right-side badge rail so long titles no
// longer steal its width. The tooltip shows the full value when truncated, else
// tags it as a workspace or branch label.
export function PaletteOpenTabWorktreeRailLabel({
  name,
  matchRange,
  worktree,
  className,
  slot = 'palette-open-tab-worktree'
}: {
  name: string
  matchRange: MatchRange | null
  worktree?: Pick<Worktree, 'branch'> | null
  className?: string
  slot?: string
}): React.JSX.Element | null {
  const [truncated, setTruncated] = useState(false)
  const labelRef = useRef<HTMLSpanElement | null>(null)
  // Why observe in an effect: unmount disconnects the ResizeObserver instead of
  // leaking the callback-ref subscription (react-doctor effect-needs-cleanup).
  useLayoutEffect(() => {
    const node = labelRef.current
    if (!node) {
      setTruncated(false)
      return
    }
    const updateTruncated = (): void => {
      const next = node.scrollWidth > node.clientWidth
      setTruncated((current) => (current === next ? current : next))
    }
    updateTruncated()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(updateTruncated)
    observer.observe(node)
    return () => observer.disconnect()
  }, [name])

  if (name.trim().length === 0) {
    return null
  }
  // Why tag the visible value: a custom display name or folder path is a workspace
  // label, not a branch, even when the workspace sits on one.
  const isBranch = worktree != null && name === resolveWorktreeBranchLabel(worktree)
  const tooltip = resolveOpenTabWorktreeRailTooltip({ isBranch, truncated, name })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={labelRef} data-slot={slot} tabIndex={-1} className={className}>
          <HighlightedRailText text={name} matchRange={matchRange} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-80 break-all">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
