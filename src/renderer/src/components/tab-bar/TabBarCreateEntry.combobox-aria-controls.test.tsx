// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabEntryOption } from './tab-create-entry-action'
import type { OpenTabSearchResult } from './open-tab-search'
import type { OpenTabSearchSnapshot } from './use-open-tab-search'
import { RESULT_LISTBOX_ID } from './TabBarCreateEntryRow'
import { TooltipProvider } from '@/components/ui/tooltip'

// The omnibox e2e (tab-create-entry-file-paths.spec.ts) locates the input by
// aria-controls rather than its translated aria-label. Pin that structural
// contract here so a rename breaks this unit test alongside the e2e string.
const searchMock = vi.hoisted(() => ({
  snapshot: {
    query: '',
    results: [] as OpenTabSearchResult[],
    entries: null
  } as OpenTabSearchSnapshot
}))
const entryOptionsMock = vi.hoisted(() => ({ options: [] as TabEntryOption[] }))

vi.mock('./use-open-tab-search', () => ({
  useOpenTabSearch: () => searchMock.snapshot
}))
vi.mock('./open-tab-selection-routing', () => ({
  activateOpenTabSearchResult: vi.fn(() => ({ status: 'activated', focus: null }) as const)
}))
vi.mock('./tab-create-entry-action', () => ({
  getTabEntryOptions: () => entryOptionsMock.options,
  createTabEntryAllowAbsolutePathsSelector: () => () => true,
  isTabEntryAbsolutePathLike: () => false
}))
vi.mock('../quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({ files: [], loading: false, loadError: null })
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [],
  AgentIcon: () => null
}))

import TabBarCreateEntry from './TabBarCreateEntry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function mount(): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <TabBarCreateEntry worktreeId="wt" groupId="g" menuOpen onOpenEntry={vi.fn()} />
      </TooltipProvider>
    )
  })
}

function setQuery(value: string): void {
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('input not found')
  }
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set
  act(() => {
    nativeSetter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  searchMock.snapshot = { query: '', results: [], entries: null }
  entryOptionsMock.options = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('TabBarCreateEntry omnibox aria-controls contract', () => {
  // The e2e locator string is a literal; drift here would silently strand it.
  it('exposes the exact listbox id the e2e locator targets', () => {
    expect(RESULT_LISTBOX_ID).toBe('tab-create-entry-results')
  })

  it('renders a combobox input whose aria-controls resolves to the results node', () => {
    mount()
    setQuery('secondaryNav')

    const input = container.querySelector('input')
    expect(input?.getAttribute('role')).toBe('combobox')
    expect(input?.getAttribute('aria-controls')).toBe(RESULT_LISTBOX_ID)

    // aria-controls must point at a node that actually exists, or the locator
    // resolves to nothing in the app just as it would in a broken build.
    expect(container.querySelector(`#${RESULT_LISTBOX_ID}`)).not.toBeNull()
  })
})
