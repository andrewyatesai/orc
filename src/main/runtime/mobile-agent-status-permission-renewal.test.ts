// Parity guard for upstream #15351 ("stop an idle title retiring a pane pending a
// human answer"). A Claude pane parked on a permission prompt must NOT publish `done`
// to mobile/paired clients — the state that retires the card — while the user is still
// being asked. Claude's PermissionRequest normalizes to `waiting` (not `blocked`), and
// its idle title (`✳ …`) reads as an idle AGENT title, so the fix has to survive both
// state names under an idle title.
//
// Fork note: upstream re-derived every mobile status through a title-TIMESTAMP
// arbitration (renewMobileAgentStatusFromPtyTitle) whose idle branch is what downgraded
// the fresh `waiting`; the guard it added is that branch's escape hatch. That projection
// does not exist in this fork — the renderer path keeps `tab.agentStatus` verbatim and
// the headless path returns the retained hook row verbatim, retiring only under a
// shell/management title (terminalTitleBlocksExplicitAgentStatus). An idle Claude title
// is neither, so the pending answer already survives. These tests pin that immunity
// through the real listMobileSessionTabs seam so a future port of the upstream renewal
// cannot reintroduce the defect without carrying the guard.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusEntry } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TAB_ID = 'remote-tab'
const WORKTREE_ID = 'wt-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-remote'
// The idle Claude title the pane wears while parked on a Write permission prompt — the
// trailing same-class repaint from the upstream capture. Classifies as an idle AGENT
// title, so it does not block the explicit agent status the way a shell title would.
const IDLE_CLAUDE_TITLE = '✳ probe2.txt Write tool file'

async function createRuntime(): Promise<OrcaRuntimeService> {
  const runtime = new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: () => []
  })
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE_ID,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`id:${WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'claude',
    title: 'Terminal'
  })
  return runtime
}

/** A pending-answer status carries NO interactivePrompt on purpose: the title layer
 *  cannot express permission for Claude, so the projection's only lever is the live
 *  title, exactly the case the upstream guard defends. */
function pendingAnswerStatus(state: AgentStatusEntry['state']): AgentStatusEntry {
  const now = Date.now()
  return {
    state,
    prompt: 'Use the Write tool to create probe2.txt',
    updatedAt: now,
    stateStartedAt: now,
    agentType: 'claude',
    paneKey: PANE_KEY,
    stateHistory: []
  }
}

/** Publish a renderer graph: one Claude pane wearing `paneTitle` with the renderer's
 *  own published agent status — what a paired host mirrors to mobile. */
function publishRendererPane(
  runtime: OrcaRuntimeService,
  paneTitle: string,
  agentStatus: AgentStatusEntry
): void {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle
      }
    ],
    mobileSessionTabs: [
      {
        worktree: WORKTREE_ID,
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: `${TAB_ID}::${LEAF_ID}`,
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: `${TAB_ID}::${LEAF_ID}`,
            parentTabId: TAB_ID,
            leafId: LEAF_ID,
            title: paneTitle,
            launchAgent: 'claude',
            agentStatus,
            isActive: true
          }
        ]
      }
    ]
  } as never)
}

async function projectState(runtime: OrcaRuntimeService): Promise<string | undefined> {
  const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  const tab = result.tabs[0]
  const status =
    tab?.type === 'terminal' ? (tab.agentStatus as AgentStatusEntry | undefined) : undefined
  return status?.state
}

describe('mobile/paired projection for a Claude pane pending a human answer', () => {
  // Both names matter: Claude's PermissionRequest normalizes to `waiting`, not `blocked`,
  // so a guard written against `blocked` alone would still retire every Claude prompt.
  it.each(['waiting', 'blocked'] as const)(
    'keeps a fresh `%s` under an idle Claude title instead of publishing a title-derived done',
    async (state) => {
      const runtime = await createRuntime()
      publishRendererPane(runtime, IDLE_CLAUDE_TITLE, pendingAnswerStatus(state))
      expect(await projectState(runtime)).toBe(state)
    }
  )

  // Scoping control: the pane is kept because an idle AGENT title is the absence of
  // activity evidence, not because retirement is switched off. A genuine shell prompt
  // proves the agent released the pane and must still retire a stale spinner (#1437) —
  // and a `waiting` with no live prompt is retired the same way.
  it('still retires a fresh `waiting` to done under a shell title', async () => {
    const runtime = await createRuntime()
    publishRendererPane(runtime, 'zsh', pendingAnswerStatus('waiting'))
    expect(await projectState(runtime)).toBe('done')
  })
})
