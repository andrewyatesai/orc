// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SmartWorkspaceNameField from './SmartWorkspaceNameField'

vi.mock('@/store', () => {
  const state = {
    repos: [],
    addRepo: vi.fn(),
    checkLinearConnection: vi.fn(),
    fetchWorkItems: vi.fn(),
    fetchWorkItemsAcrossRepos: vi.fn(),
    getCachedWorkItems: vi.fn(() => null),
    linearStatus: { connected: false },
    linearStatusChecked: false,
    listLinearIssues: vi.fn(),
    preflightStatus: null,
    preflightStatusChecked: false,
    preflightStatusContextKey: null,
    refreshPreflightStatus: vi.fn(),
    searchLinearIssues: vi.fn(),
    settings: null
  }
  const useAppStore = (selector: (s: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

vi.mock('@/lib/local-preflight-context', () => ({
  getLocalPreflightContext: () => ({}),
  localPreflightContextKey: () => 'test-preflight-context'
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

// Why: the real Dialog only mounts content while `open`; the cross-repo prompt is
// closed on a fresh render, so pass children through (keeping className + slot
// markers) to inspect the footer/button bounds classes on the production markup.
type SlotProps = { className?: string; children?: React.ReactNode }
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ className, children }: SlotProps) => (
    <div data-slot="dialog-content" className={className}>
      {children}
    </div>
  ),
  DialogHeader: ({ className, children }: SlotProps) => (
    <div data-slot="dialog-header" className={className}>
      {children}
    </div>
  ),
  DialogDescription: ({ className, children }: SlotProps) => (
    <p data-slot="dialog-description" className={className}>
      {children}
    </p>
  ),
  DialogFooter: ({ className, children }: SlotProps) => (
    <div data-slot="dialog-footer" className={className}>
      {children}
    </div>
  ),
  DialogTitle: ({ children }: SlotProps) => <h2>{children}</h2>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function renderField(): void {
  act(() => {
    root.render(
      <SmartWorkspaceNameField
        repos={[]}
        repoId="repo-1"
        onRepoChange={vi.fn()}
        value=""
        onValueChange={vi.fn()}
        onGitHubItemSelect={vi.fn()}
        onBranchSelect={vi.fn()}
        onLinearIssueSelect={vi.fn()}
        selectedSource={null}
        onClearSelectedSource={vi.fn()}
        onPlainEnter={vi.fn()}
      />
    )
  })
}

function query(selector: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(selector)
  if (!el) {
    throw new Error(`missing element: ${selector}`)
  }
  return el
}

describe('SmartWorkspaceNameField cross-project dialog bounds', () => {
  // Why: a long repository displayName must not push the confirmation footer or
  // its action buttons past the dialog edge (#13317). The containment lives in
  // Tailwind classes, so assert the production markup carries them.
  it('constrains the confirmation dialog surface and header to min-w-0', () => {
    renderField()
    expect(query('[data-slot="dialog-content"]').className).toContain('min-w-0')
    expect(query('[data-slot="dialog-header"]').className).toContain('min-w-0')
    expect(query('[data-slot="dialog-description"]').className).toContain('break-words')
  })

  it('lets the footer wrap and stay bounded on narrow desktop widths', () => {
    renderField()
    const footer = query('[data-slot="dialog-footer"]')
    expect(footer.className).toContain('min-w-0')
    expect(footer.className).toContain('sm:flex-wrap')
  })

  it('truncates the "Keep current project" action inside its own bounds', () => {
    renderField()
    const keepButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-slot="button"]')
    ).find((button) => button.textContent?.includes('Keep'))
    if (!keepButton) {
      throw new Error('Keep action button not rendered')
    }
    expect(keepButton.className).toContain('min-w-0')
    expect(keepButton.className).toContain('max-w-full')

    const label = keepButton.querySelector('span')
    expect(label?.className).toContain('min-w-0')
    expect(label?.className).toContain('truncate')
  })
})
