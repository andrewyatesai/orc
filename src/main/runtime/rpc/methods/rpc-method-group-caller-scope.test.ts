import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { CallerScopeDeniedError, runWithCallerScope } from '../../runtime-caller-scope'
import { ALL_RPC_METHODS, RPC_METHOD_GROUPS, RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES } from './index'
import {
  bindRpcMethodGroupsToCallerScope,
  callerScopeExempt
} from './rpc-method-group-caller-scope'
import { defineMethod, isStreamingMethod, type RpcContext } from '../core'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const TARGET_A = 'ssh_target_a'
const REPOS = [
  { id: 'repo_local', path: '/home/me/orca', displayName: 'orca', connectionId: null },
  { id: 'repo_a', path: '/home/me/a', displayName: 'a', connectionId: TARGET_A }
]
const LOCAL_WT = 'repo_local::/home/me/orca'
const TARGET_A_WT = 'repo_a::/home/me/a'

const BROWSER_METHODS = ALL_RPC_METHODS.filter((method) => method.name.startsWith('browser.'))
const COMPUTER_METHODS = ALL_RPC_METHODS.filter((method) => method.name.startsWith('computer.'))

type Reached = { names: string[] }

function createRuntime(reached: Reached): OrcaRuntimeService {
  const store = {
    getRepos: () => REPOS,
    getRepo: (id: string) => REPOS.find((repo) => repo.id === id),
    getFolderWorkspaces: () => [],
    getWorktreeMeta: () => undefined,
    getAllWorktreeMeta: () => ({})
  }
  const runtime = new OrcaRuntimeService(store as never)
  const mutable = runtime as unknown as Record<string, unknown>
  mutable.listAllResolvedWorktrees = async () =>
    [LOCAL_WT, TARGET_A_WT].map((id) => ({
      id,
      repoId: id.split('::')[0],
      path: id.split('::')[1],
      branch: 'main',
      displayName: id,
      linkedIssue: null
    }))
  // Why: every browser command becomes a tripwire — reaching one at all means
  // the group bound let the call through.
  for (const key of Object.keys(mutable)) {
    if (key.startsWith('browser') && typeof mutable[key] === 'function') {
      mutable[key] = (): Promise<string> => {
        reached.names.push(key)
        return Promise.resolve('reached')
      }
    }
  }
  return runtime
}

async function invoke(
  methodName: string,
  params: unknown,
  runtime: OrcaRuntimeService
): Promise<unknown> {
  const method = BROWSER_METHODS.find((candidate) => candidate.name === methodName)
  if (!method) {
    throw new Error(`no such browser method: ${methodName}`)
  }
  const ctx = { runtime } as RpcContext
  return isStreamingMethod(method)
    ? method.handler(params, ctx, () => {})
    : method.handler(params, ctx)
}

describe('browser group bound at its entry, not per method', () => {
  it('covers the whole registered group — 80+ methods, one wrapper', () => {
    expect(BROWSER_METHODS.length).toBeGreaterThan(80)
  })

  it('refuses EVERY browser method for a remote caller that names no workspace', async () => {
    const reached: Reached = { names: [] }
    const runtime = createRuntime(reached)
    const allowed: string[] = []
    for (const method of BROWSER_METHODS) {
      try {
        await runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
          invoke(method.name, {}, runtime)
        )
        allowed.push(method.name)
      } catch (error) {
        if (!(error instanceof CallerScopeDeniedError)) {
          allowed.push(`${method.name} (${String(error)})`)
        }
      }
    }
    expect(allowed).toEqual([])
    expect(reached.names).toEqual([])
  })

  // Why a path: selector, not id: — an `id:` selector has its own validator, so
  // only a catalog-shaped selector proves the group rides the worktree catalog.
  it('refuses a remote caller that names a LOCAL workspace', async () => {
    const reached: Reached = { names: [] }
    const runtime = createRuntime(reached)
    for (const worktree of [`id:${LOCAL_WT}`, 'path:/home/me/orca']) {
      await expect(
        runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
          invoke('browser.click', { worktree, element: 'a' }, runtime)
        )
      ).rejects.toThrow(CallerScopeDeniedError)
    }
    expect(reached.names).toEqual([])
  })

  it('lets a remote caller drive the session of a workspace on its OWN host', async () => {
    const reached: Reached = { names: [] }
    const runtime = createRuntime(reached)
    await runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
      invoke('browser.click', { worktree: `id:${TARGET_A_WT}`, element: 'a' }, runtime)
    )
    expect(reached.names).toEqual(['browserClick'])
  })

  it('keeps eval and exec local-only even when the workspace IS in scope', async () => {
    const reached: Reached = { names: [] }
    const runtime = createRuntime(reached)
    for (const [name, params] of [
      ['browser.eval', { worktree: `id:${TARGET_A_WT}`, expression: '1+1' }],
      ['browser.exec', { worktree: `id:${TARGET_A_WT}`, command: 'Page.navigate' }]
    ] as const) {
      await expect(
        runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
          invoke(name, params, runtime)
        )
      ).rejects.toThrow(/no host selector to bound/)
    }
    expect(reached.names).toEqual([])
  })

  it('leaves local callers untouched, including the no-workspace default', async () => {
    const reached: Reached = { names: [] }
    const runtime = createRuntime(reached)
    await invoke('browser.snapshot', {}, runtime)
    await invoke('browser.profileList', {}, runtime)
    expect(reached.names).toEqual(['browserSnapshot', 'browserProfileList'])
  })
})

describe('computer group bound at its entry too', () => {
  it('refuses every computer method for any non-local caller', async () => {
    expect(COMPUTER_METHODS.length).toBeGreaterThan(10)
    const allowed: string[] = []
    for (const method of COMPUTER_METHODS) {
      for (const scope of [
        { kind: 'ssh', connectionId: TARGET_A } as const,
        { kind: 'unattributed' } as const
      ]) {
        try {
          await runWithCallerScope(scope, () =>
            isStreamingMethod(method)
              ? method.handler({}, {} as RpcContext, () => {})
              : method.handler({}, {} as RpcContext)
          )
          allowed.push(method.name)
        } catch (error) {
          if (!(error instanceof CallerScopeDeniedError)) {
            allowed.push(`${method.name} (${String(error)})`)
          }
        }
      }
    }
    expect(allowed).toEqual([])
  })

  // Why named: it drives whatever machine the app runs on, has no host selector,
  // and was registered RAW one line below the computer group for exactly as long
  // as coverage was a list somebody had to remember.
  it('covers the emulator group, which nobody ever listed', async () => {
    const emulator = ALL_RPC_METHODS.filter((method) => method.name.startsWith('emulator.'))
    expect(emulator.length).toBeGreaterThanOrEqual(19)
    const allowed: string[] = []
    for (const method of emulator) {
      try {
        await runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
          isStreamingMethod(method)
            ? method.handler({}, {} as RpcContext, () => {})
            : method.handler({}, {} as RpcContext)
        )
        allowed.push(method.name)
      } catch (error) {
        if (!(error instanceof CallerScopeDeniedError)) {
          allowed.push(`${method.name} (${String(error)})`)
        }
      }
    }
    expect(allowed).toEqual([])
  })

  // Why named: it opens a macOS System Settings pane and never touches the
  // sidecar, so the per-call guard inside sidecar-client never sees it.
  it('covers computer.permissions, which bypasses the sidecar entirely', async () => {
    const method = COMPUTER_METHODS.find((candidate) => candidate.name === 'computer.permissions')
    expect(method).toBeDefined()
    await expect(
      runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
        (method as { handler: (p: unknown, c: RpcContext) => unknown }).handler(
          { id: 'accessibility' },
          {} as RpcContext
        )
      )
    ).rejects.toThrow(CallerScopeDeniedError)
  })
})

// The whole claim, in one place: coverage is no longer a list somebody maintains.
// A group that lands tomorrow with no policy entry, no guard and no knowledge of
// caller scope is bounded because it was registered.
describe('registration IS the bound', () => {
  const newcomer = defineMethod({
    name: 'newcomer.driveTheMachine',
    params: null,
    handler: () => 'drove the machine'
  })

  function registerNewcomer(): readonly { name: string; handler: unknown }[] {
    return bindRpcMethodGroupsToCallerScope(
      { ...RPC_METHOD_GROUPS, newcomer: [newcomer] },
      RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES
    )
  }

  function registered(): { handler: (params: unknown, ctx: RpcContext) => Promise<unknown> } {
    const method = registerNewcomer().find((candidate) => candidate.name === newcomer.name)
    if (!method) {
      throw new Error('the newcomer group did not reach the registry')
    }
    return method as { handler: (params: unknown, ctx: RpcContext) => Promise<unknown> }
  }

  it('refuses an unlisted group for every non-local caller, with no code of its own', async () => {
    for (const scope of [
      { kind: 'ssh', connectionId: TARGET_A } as const,
      { kind: 'unattributed' } as const
    ]) {
      await expect(
        runWithCallerScope(scope, () => registered().handler(null, {} as RpcContext))
      ).rejects.toThrow(CallerScopeDeniedError)
    }
    // The method itself knows nothing about scope — registration is what bound it.
    expect(
      await runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
        newcomer.handler(null, {} as RpcContext)
      )
    ).toBe('drove the machine')
  })

  it('leaves the same group untouched for a local caller', async () => {
    expect(await registered().handler(null, {} as RpcContext)).toBe('drove the machine')
  })

  it('lets that group opt out only by name, and only with a reason', () => {
    const exempted = bindRpcMethodGroupsToCallerScope(
      { ...RPC_METHOD_GROUPS, newcomer: [newcomer] },
      { ...RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES, newcomer: callerScopeExempt('proof only') }
    ).find((candidate) => candidate.name === newcomer.name)
    // Exempt means unwrapped: the registry holds the group's own method object.
    expect(exempted).toBe(newcomer)
  })

  it('refuses to start with a policy naming a group that no longer exists', () => {
    expect(() =>
      bindRpcMethodGroupsToCallerScope(RPC_METHOD_GROUPS, {
        ...RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES,
        renamedAwayLastMonth: callerScopeExempt('stale')
      } as never)
    ).toThrow(/rpc_caller_scope_policy_for_unknown_group:renamedAwayLastMonth/)
  })

  it('refuses an exemption with no reason', () => {
    expect(() =>
      bindRpcMethodGroupsToCallerScope(RPC_METHOD_GROUPS, {
        status: callerScopeExempt('  ')
      })
    ).toThrow(/rpc_caller_scope_policy_needs_reason:status/)
  })

  it('refuses a group whose import resolved to nothing', () => {
    expect(() =>
      bindRpcMethodGroupsToCallerScope(
        { ...RPC_METHOD_GROUPS, newcomer: [] },
        RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES
      )
    ).toThrow(/rpc_method_group_empty:newcomer/)
  })
})
