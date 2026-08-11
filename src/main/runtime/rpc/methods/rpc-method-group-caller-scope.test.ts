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

function registeredMethod(name: string): {
  handler: (params: unknown, ctx: RpcContext) => Promise<unknown>
} {
  const method = ALL_RPC_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`no such method: ${name}`)
  }
  return method as { handler: (params: unknown, ctx: RpcContext) => Promise<unknown> }
}

// Why here: the `terminal` group is exempt because every method addresses a pane
// by handle or pane key. These three address none — two read and write one
// app-wide preference of the machine running Orca, and the multiplex claims the
// connection's binary channel before any pane is named — so the group's stated
// reason only holds while they refuse a bounded caller on their own.
describe('the exempt terminal group and the methods that name no pane', () => {
  const autoRestoreFit = registeredMethod

  function fitRuntime(reached: string[]): OrcaRuntimeService {
    return {
      getMobileAutoRestoreFitMs: () => {
        reached.push('get')
        return 1000
      },
      setMobileAutoRestoreFitMs: () => {
        reached.push('set')
        return 2000
      }
    } as unknown as OrcaRuntimeService
  }

  it('refuses the app-wide fit preference for a remote caller, both ways', async () => {
    const reached: string[] = []
    const runtime = fitRuntime(reached)
    for (const [name, params] of [
      ['terminal.getAutoRestoreFit', {}],
      ['terminal.setAutoRestoreFit', { ms: 5000 }]
    ] as const) {
      await expect(
        runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
          autoRestoreFit(name).handler(params, { runtime } as RpcContext)
        )
      ).rejects.toThrow(/no host selector to bound/)
    }
    expect(reached).toEqual([])
  })

  it('leaves the local caller — the renderer and every paired phone — untouched', async () => {
    const reached: string[] = []
    const runtime = fitRuntime(reached)
    expect(
      await autoRestoreFit('terminal.getAutoRestoreFit').handler({}, { runtime } as RpcContext)
    ).toEqual({ ms: 1000 })
    expect(
      await autoRestoreFit('terminal.setAutoRestoreFit').handler({ ms: 5000 }, {
        runtime
      } as RpcContext)
    ).toEqual({ ms: 2000 })
    expect(reached).toEqual(['get', 'set'])
  })

  it('refuses the multiplex transport, which names a pane only once frames arrive', async () => {
    await expect(
      runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
        registeredMethod('terminal.multiplex').handler({}, {} as RpcContext)
      )
    ).rejects.toThrow(/no host selector to bound/)
    // A local caller still gets the transport's own complaint, not the bound.
    await expect(
      registeredMethod('terminal.multiplex').handler({}, {} as RpcContext)
    ).rejects.toThrow(/binary_terminal_stream_required/)
  })
})

// Why here: unsubscribe takes a caller-supplied string and tears down whatever
// stream answers to it — including a pane on another host, or a browser
// screencast. The pane is named INSIDE that string, so the bound is the handle
// the id was built from, and a string no handle answers for is refused.
describe('the exempt terminal group and the subscription id that names a pane', () => {
  function unsubscribeRuntime(cleaned: string[]): OrcaRuntimeService {
    return {
      cleanupSubscription: (id: string) => cleaned.push(id),
      assertTerminalHandleInCallerScope: (handle: string) => {
        if (handle !== 'term_mine') {
          throw new CallerScopeDeniedError(`Refused: terminal ${handle}`)
        }
      }
    } as unknown as OrcaRuntimeService
  }

  it.each([
    ['another host pane', 'term_theirs:client_1'],
    ['a bare legacy handle', 'term_theirs'],
    ['a screencast id no handle answers for', 'screencast_9']
  ])('refuses %s before anything is torn down', async (_case, subscriptionId) => {
    const cleaned: string[] = []
    const runtime = unsubscribeRuntime(cleaned)
    await expect(
      runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
        registeredMethod('terminal.unsubscribe').handler({ subscriptionId }, {
          runtime
        } as RpcContext)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(cleaned).toEqual([])
  })

  it('still tears down a subscription on the caller own pane, legacy key included', async () => {
    const cleaned: string[] = []
    const runtime = unsubscribeRuntime(cleaned)
    await runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
      registeredMethod('terminal.unsubscribe').handler(
        { subscriptionId: 'term_mine', client: { id: 'client_1' } },
        { runtime } as RpcContext
      )
    )
    expect(cleaned).toEqual(['term_mine', 'term_mine:client_1'])
  })
})

// Why here: pairing is exempt because it names no selectable host object — but
// what it mints is a relay credential for the machine running Orca, so "no
// selector" has to mean local-only rather than unbounded.
describe('the exempt pairing group mints credentials for one machine only', () => {
  const pairing = {
    getEndpoints: async () => ({ endpoints: ['relay'] }),
    provisionRelay: async () => ({ credential: 'installed' })
  }

  it.each([
    ['pairing.getEndpoints', {}],
    ['pairing.provisionRelay', { deviceName: 'phone' }]
  ])('refuses %s for a remote caller even with a pairing context present', async (name, params) => {
    await expect(
      runWithCallerScope({ kind: 'ssh', connectionId: TARGET_A }, () =>
        registeredMethod(name).handler(params, { pairing } as unknown as RpcContext)
      )
    ).rejects.toThrow(/no host selector to bound/)
  })

  it('leaves the paired-device socket, which is a local caller, untouched', async () => {
    expect(
      await registeredMethod('pairing.getEndpoints').handler({}, {
        pairing
      } as unknown as RpcContext)
    ).toEqual({ endpoints: ['relay'] })
  })
})
