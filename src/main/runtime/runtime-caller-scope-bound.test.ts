import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { CallerScopeDeniedError, runWithCallerScope } from './runtime-caller-scope'
import { CallerScopedRegistry } from './runtime-caller-scope-catalog'
import { resolveGroupAddress } from './orchestration/groups'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { RuntimeTerminalSummary } from '../../shared/runtime-types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const TARGET_A = 'ssh_target_a'
const TARGET_B = 'ssh_target_b'

// Why: a repo literally named `orca` proves the bound never consults free text —
// `--text orca` used to trip an argv scanner that matched selector-shaped values.
const REPOS = [
  { id: 'repo_local', path: '/home/me/orca', displayName: 'orca', connectionId: null },
  { id: 'repo_a', path: '/home/me/a', displayName: 'a', connectionId: TARGET_A },
  { id: 'repo_a2', path: '/home/me/a2', displayName: 'a2', connectionId: TARGET_A },
  { id: 'repo_b', path: '/home/me/b', displayName: 'b', connectionId: TARGET_B }
]

const LOCAL_WT = 'repo_local::/home/me/orca'
const TARGET_A_WT = 'repo_a::/home/me/a'
const TARGET_A_PEER_WT = 'repo_a2::/home/me/a2'
const TARGET_B_WT = 'repo_b::/home/me/b'
const UNKNOWN_REPO_WT = 'repo_never_registered::/home/me/ghost'

// Why a host-pinned row: a workspace's meta can name an execution host that its
// repo does not, and ownership has to answer with the host the work runs on.
const HOST_PINNED_WT = 'repo_local::/home/me/pinned'
const LOCAL_PINNED_WT = 'repo_a::/home/me/a-pinned-local'
const WORKTREE_META: Record<string, { hostId: string }> = {
  [HOST_PINNED_WT]: { hostId: `ssh:${TARGET_A}` },
  [LOCAL_PINNED_WT]: { hostId: 'local' }
}

const AUTOMATIONS = [
  { id: 'auto_local', projectId: 'repo_local' },
  { id: 'auto_a', projectId: 'repo_a' },
  // Why: the run context names the host outright; the legacy repo says local.
  {
    id: 'auto_a_pinned',
    projectId: 'repo_local',
    runContext: {
      kind: 'workspace-run',
      projectId: 'proj_a',
      hostId: `ssh:${TARGET_A}`,
      projectHostSetupId: 'setup_a',
      repoId: 'repo_local',
      path: '/home/me/a'
    }
  }
]

const PROJECTS = [
  { id: 'proj_local', sourceRepoIds: ['repo_local'] },
  { id: 'proj_a', sourceRepoIds: ['repo_a'] },
  { id: 'proj_multi', sourceRepoIds: ['repo_local', 'repo_a'] },
  { id: 'proj_orphan', sourceRepoIds: [] }
]

const HOST_SETUPS = [
  { id: 'setup_local', projectId: 'proj_local', hostId: 'local', repoId: 'repo_local' },
  { id: 'setup_a', projectId: 'proj_a', hostId: `ssh:${TARGET_A}`, repoId: 'repo_a' },
  { id: 'setup_b', projectId: 'proj_b', hostId: `ssh:${TARGET_B}`, repoId: 'repo_b' }
]

function createRuntime(storeOverrides: Record<string, unknown> = {}): OrcaRuntimeService {
  const store = {
    getRepos: () => REPOS,
    getRepo: (id: string) => REPOS.find((repo) => repo.id === id),
    getFolderWorkspaces: () => [],
    getWorktreeMeta: (id: string) => WORKTREE_META[id],
    getAllWorktreeMeta: () => WORKTREE_META,
    listAutomations: () => AUTOMATIONS,
    getProjects: () => PROJECTS,
    getProjectHostSetups: () => HOST_SETUPS,
    ...storeOverrides
  }
  return new OrcaRuntimeService(store as never)
}

type RegistryLike = { set: (key: string, value: unknown) => unknown }

type RuntimeInternals = {
  resolveWorktreeSelector: (selector: string) => Promise<{ id: string }>
  resolveRepoSelector: (selector: string) => Promise<{ id: string }>
  resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<{ id: string }>
  resolveWorktreeRemovalTarget: (selector: string) => Promise<{ id: string }>
  getLiveLeafForHandle: (handle: string) => unknown
  listResolvedWorktrees: () => Promise<unknown[]>
  listAllResolvedWorktrees: () => Promise<unknown[]>
  handles: RegistryLike
  tabs: Map<string, unknown>
  leaves: RegistryLike & {
    replaceAll: (next: Map<string, unknown>) => ReadonlyMap<string, unknown>
    size: number
  }
  ptysById: Map<string, unknown>
  graphStatus: string
  preservedBranchCleanupByWorktreeId: Map<string, unknown>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

/**
 * Stubs the RAW catalog, never the bounded one — every test below then exercises
 * the real filter rather than a mock of it.
 */
function stubResolvedWorktrees(runtime: OrcaRuntimeService, worktreeIds: string[]): void {
  vi.spyOn(internals(runtime), 'listAllResolvedWorktrees').mockResolvedValue(
    worktreeIds.map((id) => ({
      id,
      repoId: id.split('::')[0],
      path: id.split('::')[1],
      branch: 'main',
      displayName: id,
      linkedIssue: null
    }))
  )
}

// Why: a pane key is `<tabId>:<uuid>`, so the fixture leaf ids have to be real
// UUIDs or parsePaneKey rejects the key before any bound is consulted.
const leafIdsByHandle = new Map<string, string>()

function leafIdFor(handle: string): string {
  const existing = leafIdsByHandle.get(handle)
  if (existing) {
    return existing
  }
  const suffix = String(leafIdsByHandle.size + 1).padStart(12, '0')
  const leafId = `00000000-0000-4000-8000-${suffix}`
  leafIdsByHandle.set(handle, leafId)
  return leafId
}

function paneKeyFor(handle: string): string {
  return `tab_${handle}:${leafIdFor(handle)}`
}

function registerHandle(runtime: OrcaRuntimeService, handle: string, worktreeId: string): void {
  const leafId = leafIdFor(handle)
  internals(runtime).handles.set(handle, {
    handle,
    runtimeId: runtime.getRuntimeId(),
    rendererGraphEpoch: 0,
    worktreeId,
    tabId: `tab_${handle}`,
    leafId,
    ptyId: `pty_${handle}`,
    ptyGeneration: 0
  })
  internals(runtime).leaves.set(`tab_${handle}::${leafId}`, {
    tabId: `tab_${handle}`,
    leafId,
    worktreeId,
    ptyId: `pty_${handle}`,
    ptyGeneration: 0,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    tailBuffer: [],
    tailTranscriptBuffer: [],
    tailLinesTotal: 0,
    tailTruncated: false,
    paneRuntimeId: 1
  })
}

function asSshCaller<T>(connectionId: string, run: () => T): T {
  return runWithCallerScope({ kind: 'ssh', connectionId }, run)
}

describe('remote caller bound — worktree selectors', () => {
  it('refuses a remote caller reaching a LOCAL worktree', async () => {
    const runtime = createRuntime()
    stubResolvedWorktrees(runtime, [LOCAL_WT])
    await expect(
      asSshCaller(TARGET_A, () => internals(runtime).resolveWorktreeSelector(`id:${LOCAL_WT}`))
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it("refuses a remote caller reaching another TARGET's worktree", async () => {
    const runtime = createRuntime()
    stubResolvedWorktrees(runtime, [TARGET_B_WT])
    await expect(
      asSshCaller(TARGET_A, () => internals(runtime).resolveWorktreeSelector(`id:${TARGET_B_WT}`))
    ).rejects.toThrow(/belongs to SSH host ssh_target_b/)
  })

  it('refuses an id whose owning repo is unknown rather than treating it as local', async () => {
    const runtime = createRuntime()
    stubResolvedWorktrees(runtime, [UNKNOWN_REPO_WT])
    await expect(
      asSshCaller(TARGET_A, () =>
        internals(runtime).resolveWorktreeSelector(`id:${UNKNOWN_REPO_WT}`)
      )
    ).rejects.toThrow(/could not determine/)
  })

  it('refuses an unattributed remote caller everything', async () => {
    const runtime = createRuntime()
    stubResolvedWorktrees(runtime, [TARGET_A_WT])
    await expect(
      runWithCallerScope({ kind: 'unattributed' }, () =>
        internals(runtime).resolveWorktreeSelector(`id:${TARGET_A_WT}`)
      )
    ).rejects.toThrow(/without a pane identity/)
  })

  it('still reaches a peer worktree on its OWN target (orchestration survives)', async () => {
    const runtime = createRuntime()
    stubResolvedWorktrees(runtime, [TARGET_A_WT, TARGET_A_PEER_WT, LOCAL_WT])
    const resolved = await asSshCaller(TARGET_A, () =>
      internals(runtime).resolveWorktreeSelector(`id:${TARGET_A_PEER_WT}`)
    )
    expect(resolved.id).toBe(TARGET_A_PEER_WT)
  })

  it('leaves LOCAL callers unaffected', async () => {
    const runtime = createRuntime()
    stubResolvedWorktrees(runtime, [LOCAL_WT])
    const resolved = await internals(runtime).resolveWorktreeSelector(`id:${LOCAL_WT}`)
    expect(resolved.id).toBe(LOCAL_WT)
  })

  it('bounds the explicit-id fast path that skips resolveWorktreeSelector', async () => {
    // Why: listTerminals takes the validated id and never calls the selector
    // resolver, so the bound has to hold in the validator or `id:` walks past it.
    const runtime = createRuntime()
    const resolveSpy = vi.spyOn(internals(runtime), 'resolveWorktreeSelector')
    await expect(
      asSshCaller(TARGET_A, () => runtime.listTerminals(`id:${LOCAL_WT}`))
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  // Why these shapes: `id:` has its own validator, so only selectors that must
  // go through the catalog prove the catalog is what bounds them.
  it.each(['branch:main', 'path:/home/me/orca', 'name:repo_local::/home/me/orca', '/home/me/orca'])(
    'bounds the catalog-resolved selector %s',
    async (selector) => {
      const runtime = createRuntime()
      stubResolvedWorktrees(runtime, [LOCAL_WT])
      await expect(
        asSshCaller(TARGET_A, () => internals(runtime).resolveWorktreeSelector(selector))
      ).rejects.toThrow(CallerScopeDeniedError)
    }
  )
})

describe('remote caller bound — repo selectors', () => {
  it('refuses a local repo and allows one on its own target', async () => {
    const runtime = createRuntime()
    await expect(
      asSshCaller(TARGET_A, () => internals(runtime).resolveRepoSelector('id:repo_local'))
    ).rejects.toThrow(CallerScopeDeniedError)
    const repo = await asSshCaller(TARGET_A, () =>
      internals(runtime).resolveRepoSelector('id:repo_a')
    )
    expect(repo.id).toBe('repo_a')
  })
})

describe('remote caller bound — terminal handles', () => {
  it('refuses a LOCAL terminal handle', () => {
    const runtime = createRuntime()
    registerHandle(runtime, 'term_local', LOCAL_WT)
    expect(() => asSshCaller(TARGET_A, () => runtime.resolveLeafForHandle('term_local'))).toThrow(
      CallerScopeDeniedError
    )
  })

  it('still resolves a handle on its own target, whatever the payload text is', () => {
    const runtime = createRuntime()
    registerHandle(runtime, 'term_remote', TARGET_A_WT)
    // `--text orca` collides with a repo displayName; the bound never sees values.
    expect(asSshCaller(TARGET_A, () => runtime.resolveLeafForHandle('term_remote'))).toEqual({
      ptyId: 'pty_term_remote'
    })
    expect(asSshCaller(TARGET_A, () => runtime.resolveLiveLeafForHandle('term_remote'))).toEqual({
      ptyId: 'pty_term_remote'
    })
  })
})

describe('remote caller bound — no-selector fallthrough', () => {
  it('refuses instead of returning the human-focused LOCAL pane', async () => {
    const runtime = createRuntime()
    internals(runtime).graphStatus = 'ready'
    registerHandle(runtime, 'term_local', LOCAL_WT)
    internals(runtime).tabs.set('tab_term_local', {
      tabId: 'tab_term_local',
      worktreeId: LOCAL_WT,
      activeLeafId: leafIdFor('term_local')
    })
    await expect(asSshCaller(TARGET_A, () => runtime.resolveActiveTerminal())).rejects.toThrow(
      /no terminal was named/
    )
  })

  it('resolves within scope when the caller does own a pane', async () => {
    const runtime = createRuntime()
    internals(runtime).graphStatus = 'ready'
    registerHandle(runtime, 'term_local', LOCAL_WT)
    registerHandle(runtime, 'term_remote', TARGET_A_WT)
    internals(runtime).tabs.set('tab_term_local', {
      tabId: 'tab_term_local',
      worktreeId: LOCAL_WT,
      activeLeafId: leafIdFor('term_local')
    })
    internals(runtime).tabs.set('tab_term_remote', {
      tabId: 'tab_term_remote',
      worktreeId: TARGET_A_WT,
      activeLeafId: leafIdFor('term_remote')
    })
    const handle = await asSshCaller(TARGET_A, () => runtime.resolveActiveTerminal())
    expect(runtime.resolveLeafForHandle(handle)).toEqual({ ptyId: 'pty_term_remote' })
  })
})

describe('remote caller bound — floating terminal sentinel', () => {
  it('refuses the sentinel that short-circuits resolution to a local PTY', async () => {
    const runtime = createRuntime()
    await expect(
      asSshCaller(TARGET_A, () =>
        internals(runtime).resolveTerminalWorkspaceLaunchScope(FLOATING_TERMINAL_WORKTREE_ID)
      )
    ).rejects.toThrow(/floating terminal workspace/)
    await expect(
      asSshCaller(TARGET_A, () =>
        internals(runtime).resolveTerminalWorkspaceLaunchScope(
          `id:${FLOATING_TERMINAL_WORKTREE_ID}`
        )
      )
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('leaves the sentinel available to local callers', async () => {
    const runtime = createRuntime()
    const scope = await internals(runtime).resolveTerminalWorkspaceLaunchScope(
      FLOATING_TERMINAL_WORKTREE_ID
    )
    expect(scope.id).toBe(FLOATING_TERMINAL_WORKTREE_ID)
  })
})

describe('remote caller bound — @all fan-out', () => {
  const summary = (handle: string, worktreeId: string): RuntimeTerminalSummary =>
    ({
      handle,
      ptyId: handle,
      worktreeId,
      worktreePath: '/tmp',
      branch: 'main',
      tabId: 'tab',
      leafId: handle,
      title: 'orca',
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: ''
    }) as RuntimeTerminalSummary

  it('stops at the sender target: local and other-target panes drop out', () => {
    const runtime = createRuntime()
    const terminals = [
      summary('term_local', LOCAL_WT),
      summary('term_a', TARGET_A_WT),
      summary('term_a_peer', TARGET_A_PEER_WT),
      summary('term_b', TARGET_B_WT)
    ]
    const handles = asSshCaller(TARGET_A, () =>
      resolveGroupAddress(
        '@all',
        'term_a',
        terminals,
        () => null,
        (terminal) => runtime.isWorktreeReachableByCaller(terminal.worktreeId)
      )
    )
    expect(handles).toEqual(['term_a_peer'])
  })

  it('an unattributed caller fans out to nobody', () => {
    const runtime = createRuntime()
    const handles = runWithCallerScope({ kind: 'unattributed' }, () =>
      resolveGroupAddress(
        '@all',
        'term_a',
        [summary('term_local', LOCAL_WT), summary('term_a_peer', TARGET_A_PEER_WT)],
        () => null,
        (terminal) => runtime.isWorktreeReachableByCaller(terminal.worktreeId)
      )
    )
    expect(handles).toEqual([])
  })

  it('a local caller still reaches every pane', () => {
    const runtime = createRuntime()
    const handles = resolveGroupAddress(
      '@all',
      'term_a',
      [summary('term_local', LOCAL_WT), summary('term_b', TARGET_B_WT)],
      () => null,
      (terminal) => runtime.isWorktreeReachableByCaller(terminal.worktreeId)
    )
    expect(handles).toEqual(['term_local', 'term_b'])
  })
})

// ── The inversion itself ──────────────────────────────────────────────────────
// Everything below reaches an object through a resolver that contains NO
// caller-scope code of its own. If one of these ever resolves for a remote
// caller, the catalog stopped being the bound and the per-resolver checklist is
// back.

describe('catalog bound — resolvers with no line of their own', () => {
  it('refuses getLiveLeafForHandle, the fallback under every RENDERER-owned pane', () => {
    const runtime = createRuntime()
    internals(runtime).graphStatus = 'ready'
    registerHandle(runtime, 'term_local', LOCAL_WT)
    // 21 call sites read this; not one of them mentions caller scope.
    expect(() =>
      asSshCaller(TARGET_A, () => internals(runtime).getLiveLeafForHandle('term_local'))
    ).toThrow(CallerScopeDeniedError)
  })

  it('still resolves a pane on the caller own target through that same fallback', () => {
    const runtime = createRuntime()
    internals(runtime).graphStatus = 'ready'
    registerHandle(runtime, 'term_remote', TARGET_A_WT)
    expect(
      asSshCaller(TARGET_A, () => internals(runtime).getLiveLeafForHandle('term_remote'))
    ).toBeTruthy()
  })

  it('refuses requestRendererTerminalTabMount — a resolver nobody on either pass named', () => {
    const runtime = createRuntime()
    registerHandle(runtime, 'term_local', LOCAL_WT)
    // It drives the renderer to mount a local pane and has no bound in its body.
    expect(() =>
      asSshCaller(TARGET_A, () => runtime.requestRendererTerminalTabMount('term_local'))
    ).toThrow(CallerScopeDeniedError)
  })

  it('refuses getRendererTerminalSerializerGenerationForHandle for the same reason', () => {
    const runtime = createRuntime()
    registerHandle(runtime, 'term_local', LOCAL_WT)
    expect(() =>
      asSshCaller(TARGET_A, () =>
        runtime.getRendererTerminalSerializerGenerationForHandle('term_local')
      )
    ).toThrow(CallerScopeDeniedError)
  })
})

describe('catalog bound — the terminal roster', () => {
  it('a no-selector terminal.list stops supplying local handles', async () => {
    const runtime = createRuntime()
    internals(runtime).graphStatus = 'ready'
    stubResolvedWorktrees(runtime, [LOCAL_WT, TARGET_A_WT])
    registerHandle(runtime, 'term_local', LOCAL_WT)
    registerHandle(runtime, 'term_remote', TARGET_A_WT)
    const listed = await asSshCaller(TARGET_A, () => runtime.listTerminals())
    expect(listed.terminals.map((terminal) => terminal.worktreeId)).toEqual([TARGET_A_WT])
    expect(listed.totalCount).toBe(1)
  })

  it('an unattributed caller is handed no handles at all', async () => {
    const runtime = createRuntime()
    internals(runtime).graphStatus = 'ready'
    stubResolvedWorktrees(runtime, [LOCAL_WT, TARGET_A_WT])
    registerHandle(runtime, 'term_local', LOCAL_WT)
    registerHandle(runtime, 'term_remote', TARGET_A_WT)
    const listed = await runWithCallerScope({ kind: 'unattributed' }, () => runtime.listTerminals())
    expect(listed.terminals).toEqual([])
  })

  it('a local caller still sees every pane', async () => {
    const runtime = createRuntime()
    internals(runtime).graphStatus = 'ready'
    stubResolvedWorktrees(runtime, [LOCAL_WT, TARGET_A_WT])
    registerHandle(runtime, 'term_local', LOCAL_WT)
    registerHandle(runtime, 'term_remote', TARGET_A_WT)
    const listed = await runtime.listTerminals()
    expect(listed.terminals.map((terminal) => terminal.worktreeId).sort()).toEqual(
      [LOCAL_WT, TARGET_A_WT].sort()
    )
  })
})

describe('catalog bound — the pane key is a selector too', () => {
  it('refuses resolveTerminalPane on a LOCAL pane key', () => {
    const runtime = createRuntime()
    internals(runtime).graphStatus = 'ready'
    registerHandle(runtime, 'term_local', LOCAL_WT)
    expect(() =>
      asSshCaller(TARGET_A, () => runtime.resolveTerminalPane(paneKeyFor('term_local')))
    ).toThrow(CallerScopeDeniedError)
  })

  it('refuses getTerminalWorktreeIdForPaneKey, which leaks the workspace behind a pane', () => {
    const runtime = createRuntime()
    registerHandle(runtime, 'term_local', LOCAL_WT)
    expect(() =>
      asSshCaller(TARGET_A, () => runtime.getTerminalWorktreeIdForPaneKey(paneKeyFor('term_local')))
    ).toThrow(CallerScopeDeniedError)
    expect(
      asSshCaller(TARGET_A, () => runtime.getTerminalWorktreeIdForPaneKey('tab_x::leaf_x'))
    ).toBeNull()
  })

  it('bounds a pane known only by its PTY record, which no leaf backs', () => {
    const runtime = createRuntime()
    const paneKey = `tab_orphan:${leafIdFor('orphan_pty')}`
    internals(runtime).ptysById.set('pty_orphan', {
      ptyId: 'pty_orphan',
      worktreeId: LOCAL_WT,
      paneKey,
      connected: true
    })
    expect(asSshCaller(TARGET_A, () => runtime.getTerminalWorktreeIdForPaneKey(paneKey))).toBeNull()
    expect(runtime.getTerminalWorktreeIdForPaneKey(paneKey)).toBe(LOCAL_WT)
  })

  it('leaves a pane key on the caller own target working', () => {
    const runtime = createRuntime()
    internals(runtime).graphStatus = 'ready'
    registerHandle(runtime, 'term_remote', TARGET_A_WT)
    expect(
      asSshCaller(TARGET_A, () =>
        runtime.getTerminalWorktreeIdForPaneKey(paneKeyFor('term_remote'))
      )
    ).toBe(TARGET_A_WT)
  })
})

describe('bound — orchestration point-to-point', () => {
  it('refuses a message addressed to a LOCAL pane handle', () => {
    const runtime = createRuntime()
    registerHandle(runtime, 'term_local', LOCAL_WT)
    expect(() =>
      asSshCaller(TARGET_A, () => runtime.assertTerminalHandleInCallerScope('term_local'))
    ).toThrow(CallerScopeDeniedError)
  })

  it('refuses a handle the runtime cannot attribute rather than treating it as local', () => {
    const runtime = createRuntime()
    expect(() =>
      asSshCaller(TARGET_A, () => runtime.assertTerminalHandleInCallerScope('term_never_seen'))
    ).toThrow(/could not determine/)
  })

  it('allows a peer on the caller own target, and never bothers a local caller', () => {
    const runtime = createRuntime()
    registerHandle(runtime, 'term_remote', TARGET_A_WT)
    expect(() =>
      asSshCaller(TARGET_A, () => runtime.assertTerminalHandleInCallerScope('term_remote'))
    ).not.toThrow()
    expect(() => runtime.assertTerminalHandleInCallerScope('term_never_seen')).not.toThrow()
  })
})

describe('local callers pay nothing', () => {
  it('hands the worktree catalog back by reference, unfiltered', async () => {
    const runtime = createRuntime()
    stubResolvedWorktrees(runtime, [LOCAL_WT, TARGET_A_WT, TARGET_B_WT])
    const raw = await internals(runtime).listAllResolvedWorktrees()
    // Identity, not deep-equality: no copy, no per-row ownership lookup.
    expect(await internals(runtime).listResolvedWorktrees()).toBe(raw)
  })

  it('hands the repo catalog back by reference too', () => {
    const runtime = createRuntime()
    expect(runtime.listRepos()).toBe(REPOS)
  })
})

describe('catalog bound — automations', () => {
  it('hides the automations a remote caller does not own', () => {
    const runtime = createRuntime()
    expect(asSshCaller(TARGET_A, () => runtime.listAutomations()).map((a) => a.id)).toEqual([
      'auto_a',
      'auto_a_pinned'
    ])
    expect(runWithCallerScope({ kind: 'unattributed' }, () => runtime.listAutomations())).toEqual(
      []
    )
  })

  it('refuses showAutomation on an id it may not reach, instead of reporting it missing', () => {
    const runtime = createRuntime()
    expect(() => asSshCaller(TARGET_A, () => runtime.showAutomation('auto_local'))).toThrow(
      CallerScopeDeniedError
    )
    expect(asSshCaller(TARGET_A, () => runtime.showAutomation('auto_a')).id).toBe('auto_a')
  })

  it('leaves the local caller the whole catalog, by reference', () => {
    const runtime = createRuntime()
    expect(runtime.listAutomations()).toBe(AUTOMATIONS)
  })
})

describe('catalog bound — projects and their host setups', () => {
  it('shows a project only to a caller that reaches one of its checkouts', () => {
    const runtime = createRuntime()
    expect(asSshCaller(TARGET_A, () => runtime.listProjects()).map((p) => p.id)).toEqual([
      'proj_a',
      'proj_multi'
    ])
    expect(asSshCaller(TARGET_B, () => runtime.listProjects()).map((p) => p.id)).toEqual([])
  })

  it('narrows the host-setup catalog to the caller own host', () => {
    const runtime = createRuntime()
    expect(asSshCaller(TARGET_A, () => runtime.listProjectHostSetups()).map((s) => s.id)).toEqual([
      'setup_a'
    ])
    expect(runtime.listProjectHostSetups()).toBe(HOST_SETUPS)
  })
})

describe('bound — the no-selector filesystem readers', () => {
  it('refuses browseServerDir, which stats any path on the machine running Orca', async () => {
    const runtime = createRuntime()
    await expect(asSshCaller(TARGET_A, () => runtime.browseServerDir('/'))).rejects.toThrow(
      /no host selector to bound/
    )
    await expect(
      runWithCallerScope({ kind: 'unattributed' }, () => runtime.browseServerDir('/'))
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('refuses scanNestedRepos for the same reason', async () => {
    const runtime = createRuntime()
    await expect(asSshCaller(TARGET_A, () => runtime.scanNestedRepos('/home/me'))).rejects.toThrow(
      CallerScopeDeniedError
    )
  })
})

describe('ownership answers with the execution host, not the repo alone', () => {
  it('reaches a workspace whose meta pins it to the caller host, though its repo is local', () => {
    const runtime = createRuntime()
    registerHandle(runtime, 'term_pinned', HOST_PINNED_WT)
    expect(() =>
      asSshCaller(TARGET_A, () => runtime.assertTerminalHandleInCallerScope('term_pinned'))
    ).not.toThrow()
  })

  it('refuses a workspace whose meta pins it back to the local machine', () => {
    const runtime = createRuntime()
    registerHandle(runtime, 'term_pinned_local', LOCAL_PINNED_WT)
    expect(() =>
      asSshCaller(TARGET_A, () => runtime.assertTerminalHandleInCallerScope('term_pinned_local'))
    ).toThrow(CallerScopeDeniedError)
  })
})

// Why identity assertions: this registry is swapped on every renderer graph sync,
// so "the before view" must be the map that was displaced, never a copy of it.
describe('the leaf registry swap stays O(1)', () => {
  it('hands back the displaced map and adopts the new one by reference', () => {
    const registry = new CallerScopedRegistry<{ worktreeId: string }>(
      (leaf) => leaf.worktreeId,
      (key) => `pane ${key}`
    )
    const before = new Map([['a', { worktreeId: TARGET_A_WT }]])
    registry.replaceAll(before)

    const next = new Map([['b', { worktreeId: TARGET_A_WT }]])
    expect(registry.replaceAll(next)).toBe(before)

    registry.set('c', { worktreeId: TARGET_B_WT })
    expect(next.has('c')).toBe(true)
  })

  it('gives the graph sync a before-view that the rebuild cannot mutate underneath it', () => {
    const runtime = createRuntime()
    registerHandle(runtime, 'term_graph', TARGET_A_WT)
    const before = internals(runtime).leaves.replaceAll(new Map())
    expect([...before.keys()]).toEqual([`tab_term_graph::${leafIdFor('term_graph')}`])
    expect(internals(runtime).leaves.size).toBe(0)
  })
})

// Why these four: the worktree group is exempt because "every selector resolves
// through the caller-bounded worktree and repo catalogs". These are the paths
// that do not — two take no selector at all, two parse an id instead of looking
// one up — so each has to carry the bound itself or the exemption is false.
describe('the worktree paths that skip the catalog carry the bound themselves', () => {
  const LINEAGE = {
    [TARGET_A_WT]: { worktreeId: TARGET_A_WT, parentWorktreeId: TARGET_A_PEER_WT },
    [TARGET_A_PEER_WT]: { worktreeId: TARGET_A_PEER_WT, parentWorktreeId: LOCAL_WT },
    [LOCAL_WT]: { worktreeId: LOCAL_WT, parentWorktreeId: undefined }
  }

  it('lineage lists only rows whose child AND parent the caller reaches', async () => {
    const runtime = createRuntime({ getAllWorktreeLineage: () => LINEAGE })
    // Why the peer row is hidden too: its parent is a local worktree id, and a
    // worktree id is the selector every other reach starts from.
    expect(Object.keys(await asSshCaller(TARGET_A, () => runtime.listWorktreeLineage()))).toEqual([
      TARGET_A_WT
    ])
    expect(Object.keys(await runtime.listWorktreeLineage())).toEqual(Object.keys(LINEAGE))
  })

  it('workspace lineage is filtered by the same rule', async () => {
    const runtime = createRuntime({
      getAllWorkspaceLineage: () => ({
        [`worktree:${TARGET_A_WT}`]: {
          childWorkspaceKey: `worktree:${TARGET_A_WT}`,
          parentWorkspaceKey: `worktree:${TARGET_A_PEER_WT}`
        },
        [`worktree:${LOCAL_WT}`]: {
          childWorkspaceKey: `worktree:${LOCAL_WT}`,
          parentWorkspaceKey: `worktree:${LOCAL_WT}`
        }
      })
    })
    expect(Object.keys(await asSshCaller(TARGET_A, () => runtime.listWorkspaceLineage()))).toEqual([
      `worktree:${TARGET_A_WT}`
    ])
  })

  it('persistSortOrder refuses a bulk write that names a workspace on another host', () => {
    const written: string[] = []
    const runtime = createRuntime({
      setWorktreeMeta: (id: string) => {
        written.push(id)
      }
    })
    expect(() =>
      asSshCaller(TARGET_A, () =>
        runtime.persistManagedWorktreeSortOrder([HOST_PINNED_WT, LOCAL_PINNED_WT])
      )
    ).toThrow(CallerScopeDeniedError)
    // Why the emptiness matters as much as the throw: the ids are validated up
    // front precisely so a refusal cannot leave half a reordering behind.
    expect(written).toEqual([])
  })

  it('forceDeleteBranch refuses before it can probe what cleanup is pending', async () => {
    const runtime = createRuntime()
    await expect(
      asSshCaller(TARGET_A, () =>
        runtime.forceDeletePreservedBranch(LOCAL_PINNED_WT, 'feature', 'abc123')
      )
    ).rejects.toThrow(CallerScopeDeniedError)
    // The same call from the owning host gets the ordinary not-pending answer,
    // which is how we know the refusal above was the bound and not the probe.
    await expect(
      asSshCaller(TARGET_A, () =>
        runtime.forceDeletePreservedBranch(HOST_PINNED_WT, 'feature', 'abc123')
      )
    ).rejects.toThrow(/No preserved branch cleanup is pending/)
  })

  it('rm refuses the fallback target Git no longer lists', async () => {
    const runtime = createRuntime()
    stubResolvedWorktrees(runtime, [])
    // Why the bare id and not `id:<id>`: the `id:` form is asserted by the
    // selector validator, so only this form reaches the parse-only fallback.
    await expect(
      asSshCaller(TARGET_A, () => internals(runtime).resolveWorktreeRemovalTarget(LOCAL_PINNED_WT))
    ).rejects.toThrow(CallerScopeDeniedError)
    await expect(
      asSshCaller(TARGET_A, () => internals(runtime).resolveWorktreeRemovalTarget(HOST_PINNED_WT))
    ).resolves.toMatchObject({ id: HOST_PINNED_WT })
  })
})
