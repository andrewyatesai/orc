import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GitHistoryItem } from '../../../../shared/git-history'
import type { GitHistoryItemViewModel } from '../../../../shared/git-history-graph'
import { GitHistoryRow } from './GitHistoryRow'

// Mirror the fork's tab-title-tooltip convention: render the real row but expose
// what it hands TooltipContent, so the wrap-preserving props are asserted at the seam.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({
    children,
    className,
    side,
    sideOffset,
    collisionPadding
  }: {
    children: ReactNode
    className?: string
    side?: string
    sideOffset?: number
    collisionPadding?: number
  }) => (
    <div
      data-tooltip-content
      data-side={side}
      data-side-offset={sideOffset}
      data-collision-padding={collisionPadding}
      className={className}
    >
      {children}
    </div>
  ),
  TooltipTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) => {
    if (asChild && isValidElement(children)) {
      return cloneElement(children as ReactElement<Record<string, unknown>>, {
        'data-tooltip-trigger': 'true'
      })
    }
    return <span data-tooltip-trigger>{children}</span>
  }
}))

const subject = 'brew-install: source shared brew context before resolving prefixes'
const conventionalLine = 'Keep this conventional commit-message body line intact through column 72'
const commitMessage = `${subject}

${conventionalLine}
the resolved prefix list now feeds both the cask audit and the formula
path checks, so a missing context aborts before any network call runs.`

function makeViewModel(): GitHistoryItemViewModel {
  const historyItem: GitHistoryItem = {
    id: '52ad492abcd',
    parentIds: [],
    subject,
    message: commitMessage,
    displayId: '52ad492',
    author: 'Taylor',
    timestamp: new Date(2026, 7, 12, 12).getTime(),
    references: []
  }
  return { historyItem, inputSwimlanes: [], outputSwimlanes: [], kind: 'node' }
}

describe('GitHistoryRow commit tooltip', () => {
  const markup = renderToStaticMarkup(<GitHistoryRow viewModel={makeViewModel()} />)

  it('feeds the full multi-line commit message to the tooltip', () => {
    expect(markup).toContain('data-tooltip-content')
    expect(markup).toContain(conventionalLine)
  })

  it('wraps by width and preserves line breaks instead of the old fixed max width', () => {
    expect(markup).toContain('whitespace-pre-wrap')
    expect(markup).toContain('break-words')
    expect(markup).toContain('text-wrap')
    expect(markup).toContain('max-w-[min(76ch,var(--radix-tooltip-content-available-width))]')
    // The pre-fix fixed width truncated long conventional lines; it must be gone.
    expect(markup).not.toContain('max-w-96')
  })

  it('keeps the tooltip inside the viewport with collision padding', () => {
    expect(markup).toContain('data-side="bottom"')
    expect(markup).toContain('data-side-offset="6"')
    expect(markup).toContain('data-collision-padding="8"')
  })
})
