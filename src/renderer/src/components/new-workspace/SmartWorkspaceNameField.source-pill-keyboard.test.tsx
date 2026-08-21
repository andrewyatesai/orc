// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SmartWorkspaceNameField, {
  type SmartWorkspaceNameSelection
} from './SmartWorkspaceNameField'

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

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

let container: HTMLDivElement
let root: Root
const openUrl = vi.fn()

beforeEach(() => {
  openUrl.mockReset()
  ;(window as unknown as { api: unknown }).api = { shell: { openUrl } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  Reflect.deleteProperty(window, 'api')
})

function renderPill(
  selectedSource: SmartWorkspaceNameSelection,
  spies: { onClearSelectedSource?: () => void; onPlainEnter?: () => void } = {}
): HTMLElement {
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
        selectedSource={selectedSource}
        onClearSelectedSource={spies.onClearSelectedSource ?? vi.fn()}
        onPlainEnter={spies.onPlainEnter ?? vi.fn()}
      />
    )
  })
  const pill = container.querySelector<HTMLElement>('[data-workspace-source-pill="true"]')
  if (!pill) {
    throw new Error('selected-source pill not rendered')
  }
  return pill
}

function pressKey(el: HTMLElement, key: string, init?: KeyboardEventInit): void {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    el.dispatchEvent(event)
  })
}

const linkedSource: SmartWorkspaceNameSelection = {
  kind: 'github-issue',
  label: 'Issue #123',
  url: 'https://github.com/orca/ide/issues/123'
}

describe('SmartWorkspaceNameField selected-source pill keyboard flow', () => {
  it('keeps the pill action buttons out of the Tab order', () => {
    renderPill(linkedSource)

    const openButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open link in browser"]'
    )
    const clearButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Clear selected source"]'
    )

    expect(openButton?.tabIndex).toBe(-1)
    expect(clearButton?.tabIndex).toBe(-1)
  })

  it('advertises the pill keyboard shortcuts, including Alt+Enter when a URL exists', () => {
    const pill = renderPill(linkedSource)
    expect(pill.getAttribute('aria-keyshortcuts')).toBe('Alt+Enter Backspace Delete')
  })

  it('omits the open shortcut when the source has no URL', () => {
    const pill = renderPill({ kind: 'branch', label: 'feature/login' })
    expect(pill.getAttribute('aria-keyshortcuts')).toBe('Backspace Delete')
  })

  it('clears the selection on Backspace', () => {
    const onClearSelectedSource = vi.fn()
    const pill = renderPill(linkedSource, { onClearSelectedSource })

    pressKey(pill, 'Backspace')

    expect(onClearSelectedSource).toHaveBeenCalledOnce()
  })

  it('clears the selection on Delete', () => {
    const onClearSelectedSource = vi.fn()
    const pill = renderPill(linkedSource, { onClearSelectedSource })

    pressKey(pill, 'Delete')

    expect(onClearSelectedSource).toHaveBeenCalledOnce()
  })

  it('opens the source URL on Alt+Enter without advancing focus', () => {
    const onPlainEnter = vi.fn()
    const pill = renderPill(linkedSource, { onPlainEnter })

    pressKey(pill, 'Enter', { altKey: true })

    expect(openUrl).toHaveBeenCalledWith('https://github.com/orca/ide/issues/123')
    expect(onPlainEnter).not.toHaveBeenCalled()
  })

  it('still advances focus on a plain Enter', () => {
    const onPlainEnter = vi.fn()
    const pill = renderPill(linkedSource, { onPlainEnter })

    pressKey(pill, 'Enter')

    expect(onPlainEnter).toHaveBeenCalledOnce()
    expect(openUrl).not.toHaveBeenCalled()
  })
})
