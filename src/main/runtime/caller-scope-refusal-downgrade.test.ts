/**
 * A refusal that reads as an ordinary negative is worse than no bound at all:
 * the caller learns something false ("no agent there", "no such repo"), and the
 * boundary stops being visible to the people auditing it. Every case here is a
 * method whose normal answer for a failure is a value, not a throw — so the
 * refusal has to be re-raised through it, and the ordinary negative has to
 * survive unchanged.
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { CallerScopeDeniedError, runWithCallerScope } from './runtime-caller-scope'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const MINE = 'ssh_target_a'
const THEIRS = 'ssh_target_b'
const REPOS = [
  { id: 'repo_a', path: '/home/me/a', displayName: 'a', connectionId: MINE },
  { id: 'repo_b', path: '/home/me/b', displayName: 'b', connectionId: THEIRS }
]
const MY_WT = 'repo_a::/home/me/a'
const THEIR_WT = 'repo_b::/home/me/b'
const MY_HANDLE = 'term_mine'
const THEIR_HANDLE = 'term_theirs'
const LEAF_ID = '00000000-0000-4000-8000-000000000001'

type Internals = {
  handles: { set: (key: string, value: unknown) => unknown }
  leaves: { set: (key: string, value: unknown) => unknown }
  listAllResolvedWorktrees: () => Promise<unknown[]>
  claudeAgentTeams: {
    createLaunchEnv: (args: {
      leaderHandle: string
      baseEnv: Record<string, string>
      shimDir: string
      shimBin: string
    }) => { teamId: string; token: string }
  }
}

function createRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService({
    getRepos: () => REPOS,
    getRepo: (id: string) => REPOS.find((repo) => repo.id === id),
    getFolderWorkspaces: () => [],
    getWorktreeMeta: () => undefined,
    getAllWorktreeMeta: () => ({}),
    setWorktreeMeta: () => undefined,
    getSettings: () => ({})
  } as never)
  const internals = runtime as unknown as Internals
  internals.listAllResolvedWorktrees = async () =>
    [MY_WT, THEIR_WT].map((id) => ({
      id,
      repoId: id.split('::')[0],
      path: id.split('::')[1],
      branch: 'main',
      displayName: id,
      linkedIssue: null
    }))
  // Why both panes exist: only a handle the registry knows can prove the refusal
  // came from the bound rather than from the handle being unknown.
  for (const [handle, worktreeId] of [
    [MY_HANDLE, MY_WT],
    [THEIR_HANDLE, THEIR_WT]
  ]) {
    internals.handles.set(handle, {
      handle,
      runtimeId: runtime.getRuntimeId(),
      rendererGraphEpoch: 0,
      worktreeId,
      tabId: `tab_${handle}`,
      leafId: LEAF_ID,
      ptyId: null,
      ptyGeneration: 0
    })
  }
  return runtime
}

function asCaller<T>(run: () => T): T {
  return runWithCallerScope({ kind: 'ssh', connectionId: MINE }, run)
}

describe('isRunningAgent re-raises the refusal its catch-all would have eaten', () => {
  it('refuses a pane on another host instead of reporting it agent-free', async () => {
    await expect(
      asCaller(() => createRuntime().isTerminalRunningAgent(THEIR_HANDLE))
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('still answers false when the pane is reachable and the probe simply fails', async () => {
    // No leaf backs this handle, which is the probe failure the catch-all exists
    // for — and the answer for it is unchanged.
    await expect(asCaller(() => createRuntime().isTerminalRunningAgent(MY_HANDLE))).resolves.toBe(
      false
    )
  })
})

describe('resolvePr/MrBase re-raise the refusal their error value would have hidden', () => {
  it.each([
    ['resolveManagedPrBase', { repoSelector: 'repo_b', prNumber: 1 }],
    ['resolveManagedMrBase', { repoSelector: 'repo_b', mrIid: 1 }]
  ] as const)('%s refuses a repo on another host', async (method, args) => {
    const runtime = createRuntime() as unknown as Record<string, (a: unknown) => Promise<unknown>>
    await expect(asCaller(() => runtime[method](args))).rejects.toThrow(CallerScopeDeniedError)
  })

  it.each([
    ['resolveManagedPrBase', { repoSelector: 'repo_never_registered', prNumber: 1 }],
    ['resolveManagedMrBase', { repoSelector: 'repo_never_registered', mrIid: 1 }]
  ] as const)('%s still reports a genuinely unknown repo as data', async (method, args) => {
    const runtime = createRuntime() as unknown as Record<string, (a: unknown) => Promise<unknown>>
    await expect(asCaller(() => runtime[method](args))).resolves.toEqual({
      error: 'Repo not found'
    })
  })
})

describe('the Linear --current resolver tells staleness apart from a refusal', () => {
  it('refuses a context terminal on another host', async () => {
    await expect(
      asCaller(() => createRuntime().linearResolveCurrentIssue({ terminalHandle: THEIR_HANDLE }))
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('still falls back to cwd when the context terminal is merely unknown', async () => {
    // Why this shape proves the fallback survived: the answer is the cwd path's
    // own verdict on a worktree it DID resolve, not a re-raised refusal.
    await expect(
      asCaller(() =>
        createRuntime().linearResolveCurrentIssue({
          terminalHandle: 'term_long_gone',
          cwd: '/home/me/a'
        })
      )
    ).rejects.toMatchObject({ code: 'linear_no_linked_issue' })
  })
})

describe('agentTeams tmux compat refuses before its exit-code wrapper can swallow it', () => {
  function teamFor(
    runtime: OrcaRuntimeService,
    leaderHandle: string
  ): {
    teamId: string
    token: string
  } {
    return (runtime as unknown as Internals).claudeAgentTeams.createLaunchEnv({
      leaderHandle,
      baseEnv: {},
      shimDir: '/tmp/shim',
      shimBin: 'tmux'
    })
  }

  it('refuses a team whose leader pane belongs to another host', async () => {
    const runtime = createRuntime()
    const team = teamFor(runtime, THEIR_HANDLE)
    await expect(
      asCaller(() =>
        runtime.handleAgentTeamsTmuxCompat({ ...team, envPane: '%1', argv: ['list-panes'] })
      )
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('refuses a team nothing can attribute rather than answering exit code 1', async () => {
    await expect(
      asCaller(() =>
        createRuntime().handleAgentTeamsTmuxCompat({
          teamId: 'team_never_minted',
          token: 'tok',
          envPane: '%1',
          argv: ['list-panes']
        })
      )
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('still answers a caller on the leader own host through the tmux wrapper', async () => {
    const runtime = createRuntime()
    const team = teamFor(runtime, MY_HANDLE)
    await expect(
      asCaller(() =>
        runtime.handleAgentTeamsTmuxCompat({ ...team, envPane: '%1', argv: ['list-panes'] })
      )
    ).resolves.toMatchObject({ ok: expect.any(Boolean) })
  })
})
