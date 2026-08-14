// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabEntryOption } from './tab-create-entry-action'
import type { OpenTabSearchResult } from './open-tab-search'
import type { OpenTabSearchSnapshot } from './use-open-tab-search'
import { TooltipProvider } from '@/components/ui/tooltip'

// The gate under test lives in the component; stub the search hook and the
// activation router so the test drives exactly which snapshot the omnibox sees.
const searchMock = vi.hoisted(() => ({
  snapshot: { query: '', results: [] as OpenTabSearchResult[] } as OpenTabSearchSnapshot
}))
const routingMock = vi.hoisted(() => ({
  activate: vi.fn(() => ({ status: 'activated', focus: null }) as const)
}))
const entryOptionsMock = vi.hoisted(() => ({ options: [] as TabEntryOption[] }))

vi.mock('./use-open-tab-search', () => ({
  useOpenTabSearch: () => searchMock.snapshot
}))
vi.mock('./open-tab-selection-routing', () => ({
  activateOpenTabSearchResult: routingMock.activate
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

const tabResult: OpenTabSearchResult = {
  source: 'workspace',
  id: 'open-tab:workspace:tab-1',
  title: 'My Terminal Tab',
  matchedText: null,
  worktreeId: 'wt',
  contentType: 'terminal',
  tabId: 'tab-1',
  entityId: 'term-1',
  groupId: 'g',
  relativePath: null
}

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

function submitForm(): void {
  const form = container.querySelector('form')
  if (!form) {
    throw new Error('form not found')
  }
  act(() => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  searchMock.snapshot = { query: '', results: [] }
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

describe('TabBarCreateEntry tab result gating', () => {
  it('offers and activates a tab row whose results describe the current query', () => {
    searchMock.snapshot = { query: 'term', results: [tabResult] }
    mount()
    setQuery('term')

    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)

    submitForm()
    expect(routingMock.activate).toHaveBeenCalledWith(tabResult)
  })

  it('suppresses tab rows still describing an earlier query the user typed past', () => {
    // The deferred search has not caught up: its rows describe "old", not "term".
    searchMock.snapshot = { query: 'old', results: [tabResult] }
    mount()
    setQuery('term')

    // No stale row is shown, and Enter never submits a tab the query never matched.
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
    submitForm()
    expect(routingMock.activate).not.toHaveBeenCalled()
  })
})
