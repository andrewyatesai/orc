// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabEntryOption } from './tab-create-entry-action'
import type { OpenTabSearchResult } from './open-tab-search'
import type { OpenTabSearchEntries } from './open-tab-search-entries'
import type { OpenTabSearchSnapshot } from './use-open-tab-search'
import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import type { Tab, Worktree } from '../../../../shared/types'
import { TooltipProvider } from '@/components/ui/tooltip'

// The gate under test lives in the component; stub the search hook and the
// activation router so the test drives exactly which snapshot the omnibox sees.
const searchMock = vi.hoisted(() => ({
  snapshot: {
    query: '',
    results: [] as OpenTabSearchResult[],
    entries: null
  } as OpenTabSearchSnapshot
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
  relativePath: null,
  occupantAgent: null
}

const worktree: Worktree = {
  id: 'wt',
  repoId: 'repo-1',
  path: '/tmp/wt',
  head: 'abc123',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: false,
  displayName: 'Aurora Workspace',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

// Real entries behind `tabResult`, so the hook's retention re-runs the live
// search engine against them instead of a hand-built double.
function workspaceEntriesForTab1(title: string): OpenTabSearchEntries {
  const tab: Tab = {
    id: 'tab-1',
    entityId: 'term-1',
    groupId: 'g',
    worktreeId: worktree.id,
    contentType: 'terminal',
    label: title,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const workspaceTab: SearchableWorkspaceTab = {
    tab: tab as SearchableWorkspaceTab['tab'],
    worktree,
    repoName: 'octo/rocket',
    worktreeSortIndex: 0,
    groupSortIndex: 0,
    tabSortIndex: 0,
    title,
    secondaryText: '',
    titleSearchText: title,
    secondarySearchTexts: [],
    agentMetadata: [],
    occupantAgent: null,
    isCurrentTab: false,
    isCurrentWorktree: true
  }
  return { workspaceTabs: [workspaceTab], browserPages: [], simulatorTabs: [] }
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

describe('TabBarCreateEntry tab result gating', () => {
  it('offers and activates a tab row whose results describe the current query', () => {
    searchMock.snapshot = { query: 'term', results: [tabResult], entries: null }
    mount()
    setQuery('term')

    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)

    submitForm()
    expect(routingMock.activate).toHaveBeenCalledWith(tabResult)
  })

  it('suppresses tab rows still describing an earlier query the user typed past', () => {
    // The deferred search has not caught up and its entries are gone: the rows
    // describe "old", not "term", and nothing behind them can be re-checked.
    searchMock.snapshot = { query: 'old', results: [tabResult], entries: null }
    mount()
    setQuery('term')

    // No stale row is shown, and Enter never submits a tab the query never matched.
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
    submitForm()
    expect(routingMock.activate).not.toHaveBeenCalled()
  })

  it('keeps a deferred tab row the newer query still matches', () => {
    // The deferred snapshot stays pinned to "my term" while the user backspaces,
    // but the entry behind the row still matches the live query, so retention
    // (through the real search engine) keeps it on screen instead of flashing.
    searchMock.snapshot = {
      query: 'my term',
      results: [tabResult],
      entries: workspaceEntriesForTab1('My Terminal Tab')
    }
    mount()

    setQuery('my term')
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)

    setQuery('my ter')
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)

    submitForm()
    expect(routingMock.activate).toHaveBeenCalledWith(tabResult)
  })
})
