// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PaletteOpenTabWorktreeRailLabel,
  resolveOpenTabWorktreeRailTooltip
} from './palette-open-tab-worktree-rail-label'

// Render TooltipContent unconditionally so its resolved value is assertable
// without driving Radix open state, mirroring truncated-sidebar-label.test.tsx.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className} data-tooltip-content="">
      {children}
    </div>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

// Keep the branch/workspace tag deterministic without booting i18n.
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('resolveOpenTabWorktreeRailTooltip', () => {
  it('returns the full name when truncated', () => {
    expect(
      resolveOpenTabWorktreeRailTooltip({ truncated: true, isBranch: true, name: 'feature/xyz' })
    ).toBe('feature/xyz')
  })

  it('tags a branch label when not truncated', () => {
    expect(
      resolveOpenTabWorktreeRailTooltip({ truncated: false, isBranch: true, name: 'main' })
    ).toBe('Branch name')
  })

  it('tags a workspace label when not truncated and not a branch', () => {
    expect(
      resolveOpenTabWorktreeRailTooltip({
        truncated: false,
        isBranch: false,
        name: 'user-support'
      })
    ).toBe('Workspace name')
  })
})

describe('PaletteOpenTabWorktreeRailLabel', () => {
  let container: HTMLDivElement
  let root: Root
  let originalClientWidth: PropertyDescriptor | undefined
  let originalScrollWidth: PropertyDescriptor | undefined

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 120
      }
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get() {
        return this.textContent?.includes('overflowing') ? 400 : 80
      }
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    }
    if (originalScrollWidth) {
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth)
    } else {
      delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth
    }
  })

  it('renders nothing when the name is blank', async () => {
    await act(async () => {
      root.render(<PaletteOpenTabWorktreeRailLabel name="   " matchRange={null} />)
    })
    expect(container.querySelector('[data-slot="palette-open-tab-worktree"]')).toBeNull()
    expect(container.querySelector('[data-tooltip-content]')).toBeNull()
  })

  it('shows the name in its own slot and tags it as a workspace when the visible value is not the branch', async () => {
    await act(async () => {
      root.render(
        <PaletteOpenTabWorktreeRailLabel
          name="user-support"
          matchRange={null}
          worktree={{ branch: 'main' }}
        />
      )
    })
    const label = container.querySelector('[data-slot="palette-open-tab-worktree"]')
    expect(label?.textContent).toBe('user-support')
    expect(container.querySelector('[data-tooltip-content]')?.textContent).toBe('Workspace name')
  })

  it('tags the label as a branch when the visible value is the resolved branch', async () => {
    await act(async () => {
      root.render(
        <PaletteOpenTabWorktreeRailLabel
          name="main"
          matchRange={null}
          worktree={{ branch: 'refs/heads/main' }}
          slot="palette-worktree-branch"
        />
      )
    })
    expect(container.querySelector('[data-slot="palette-worktree-branch"]')?.textContent).toBe(
      'main'
    )
    expect(container.querySelector('[data-tooltip-content]')?.textContent).toBe('Branch name')
  })

  it('shows the full name in the tooltip when the label overflows', async () => {
    await act(async () => {
      root.render(
        <PaletteOpenTabWorktreeRailLabel
          name="an-overflowing-workspace-name"
          matchRange={null}
          worktree={{ branch: 'main' }}
        />
      )
    })
    expect(container.querySelector('[data-tooltip-content]')?.textContent).toBe(
      'an-overflowing-workspace-name'
    )
  })
})
