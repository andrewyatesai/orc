// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makePaneKey } from '../../../shared/stable-pane-identity'
import type { Repo, Tab, TabGroup, TerminalTab, Worktree } from '../../../shared/types'
import type { AgentStatusEntry, AgentStatusState } from '../../../shared/agent-status-types'
import WorktreeJumpPalette from './WorktreeJumpPalette'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18Next>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key
    })
  }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))

vi.mock('@/components/repo/RepoBadgeLabel', () => ({
  RepoBadgeMark: () => <span data-repo-badge-mark="true" />
}))

vi.mock('@/components/cmd-j/palette-host-badge', () => ({
  getPaletteHostBadge: () => null
}))

// Why: the query setter is captured here so the test can drive the search path — the whole point of
// the fix is that an Open Tabs row surfaced by a query keeps its live agent status dot.
let setCommandQuery: ((next: string) => void) | null = null

vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
      open ? <div data-command-dialog="true">{children}</div> : null,
    CommandInput: ({
      value,
      onValueChange
    }: {
      value?: string
      onValueChange?: (next: string) => void
    }) => {
      setCommandQuery = onValueChange ?? null
      return (
        <input
          data-command-input="true"
          value={value}
          onChange={(event) => onValueChange?.(event.currentTarget.value)}
        />
      )
    },
    CommandList: React.forwardRef(function CommandList(
      { children }: { children: React.ReactNode },
      ref: React.ForwardedRef<HTMLDivElement>
    ) {
      return <div ref={ref}>{children}</div>
    }),
    CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandItem: ({ children, value }: { children: React.ReactNode; value?: string }) => (
      <button data-command-item={value ?? ''} type="button">
        {children}
      </button>
    )
  }
})

const REPO_ID = 'repo-1'
const LEAF_ID = '11111111-2222-4333-8444-555555555555'

function makeRepo(): Repo {
  return {
    id: REPO_ID,
    path: '/repos/repo-1',
    displayName: 'Repo 1',
    badgeColor: '#000000',
    addedAt: 0
  }
}

function makeWorktree(id: string, displayName: string): Worktree {
  return {
    id,
    repoId: REPO_ID,
    path: `/home/${id}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName,
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
}

function makeTerminalTab(id: string, worktreeId: string, title: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeUnifiedTab(id: string, worktreeId: string, entityId: string, label: string): Tab {
  return {
    id,
    entityId,
    groupId: `group-${worktreeId}`,
    worktreeId,
    contentType: 'terminal',
    label,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeGroup(worktreeId: string, tabIds: string[]): TabGroup {
  return {
    id: `group-${worktreeId}`,
    worktreeId,
    activeTabId: tabIds[0] ?? null,
    tabOrder: tabIds,
    recentTabIds: tabIds
  }
}

function makeAgentEntry(tabId: string, state: AgentStatusState, at: number): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: at,
    stateStartedAt: at,
    paneKey: makePaneKey(tabId, LEAF_ID),
    stateHistory: []
  }
}

const initialAppState = useAppStore.getInitialState()
let testContainer: HTMLDivElement
let testRoot: Root

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderOpenPalette(overrides: Partial<AppState>): Promise<void> {
  useAppStore.setState({
    activeModal: 'worktree-palette',
    activeWorktreeId: null,
    repos: [makeRepo()],
    worktreesByRepo: {
      [REPO_ID]: [
        makeWorktree('wt-alpha', 'Alpha workspace'),
        makeWorktree('wt-beta', 'Beta workspace')
      ]
    },
    showSleepingWorkspaces: true,
    ptyIdsByTabId: { 'term-alpha': ['pty-term-alpha'], 'term-beta': ['pty-term-beta'] },
    tabsByWorktree: {
      'wt-alpha': [makeTerminalTab('term-alpha', 'wt-alpha', 'Alpha chat')],
      'wt-beta': [makeTerminalTab('term-beta', 'wt-beta', 'Beta chat')]
    },
    unifiedTabsByWorktree: {
      'wt-alpha': [makeUnifiedTab('tab-alpha', 'wt-alpha', 'term-alpha', 'Alpha chat')],
      'wt-beta': [makeUnifiedTab('tab-beta', 'wt-beta', 'term-beta', 'Beta chat')]
    },
    groupsByWorktree: {
      'wt-alpha': [makeGroup('wt-alpha', ['tab-alpha'])],
      'wt-beta': [makeGroup('wt-beta', ['tab-beta'])]
    },
    activeGroupIdByWorktree: { 'wt-alpha': 'group-wt-alpha', 'wt-beta': 'group-wt-beta' },
    ...overrides
  } as Partial<AppState>)

  await act(async () => {
    testRoot.render(<WorktreeJumpPalette />)
  })
  await flushEffects()
}

function getTabRowIds(): string[] {
  return [
    ...testContainer.querySelectorAll<HTMLElement>('[data-command-item^="workspace-tab:"]')
  ].map((node) => (node.dataset.commandItem ?? '').replace('workspace-tab:', ''))
}

describe('WorktreeJumpPalette agent badge on searched Open Tabs rows', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    useAppStore.setState(initialAppState, true)
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => testRoot.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('keeps the agent status dot on an Open Tabs row a query surfaced', async () => {
    await renderOpenPalette({
      agentStatusByPaneKey: {
        [makePaneKey('term-alpha', LEAF_ID)]: makeAgentEntry('term-alpha', 'working', Date.now())
      }
    })

    // Why not optional-call: a skipped setter would leave the empty-query Recent section standing and
    // the assertions below would pass without the typed-query path ever running.
    const applyQuery = setCommandQuery
    if (!applyQuery) {
      throw new Error('CommandInput never installed a query setter')
    }
    await act(async () => {
      applyQuery('Alpha')
    })
    await flushEffects()

    // Why: searching for a tab is exactly when its status matters — the pip must survive the query.
    expect(getTabRowIds()).toContain('tab-alpha')
    expect(getTabRowIds()).not.toContain('tab-beta')
    const alphaRow = testContainer.querySelector<HTMLElement>(
      '[data-command-item="workspace-tab:tab-alpha"]'
    )
    expect(alphaRow?.querySelector('[title="Working"]')).not.toBeNull()
  })
})
