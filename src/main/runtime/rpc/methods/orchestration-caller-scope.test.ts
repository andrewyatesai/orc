import { describe, expect, it, vi } from 'vitest'
import { CallerScopeDeniedError, runWithCallerScope } from '../../runtime-caller-scope'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const REMOTE = { kind: 'ssh', connectionId: 'ssh_target_a' } as const
const IN_SCOPE = 'term_remote'
const IN_SCOPE_WT = 'id:repo_a::/home/me/a'

// Why: `--to` is a handle, and delivery can follow a persisted pane key when the
// handle registry no longer holds it — so these surfaces name the recipient
// themselves. Every state-changing call below is a tripwire.
function createRuntime(dbOverrides: Record<string, unknown> = {}): {
  runtime: unknown
  asked: string[]
} {
  const asked: string[] = []
  const reached = (what: string) => (): never => {
    throw new Error(`reached ${what}`)
  }
  const db = {
    getTask: () => ({ id: 'task_1', status: 'ready', spec: 'do the thing' }),
    insertMessage: reached('insertMessage'),
    createDispatchContext: reached('createDispatchContext'),
    getMessageById: () => undefined,
    getAllMessagesForHandle: () => [],
    getUnreadMessages: reached('getUnreadMessages'),
    markAsRead: reached('markAsRead'),
    getInbox: () => [],
    getGate: () => undefined,
    getDispatchContext: () => undefined,
    resolveGate: reached('resolveGate'),
    getActiveCoordinatorRuns: () => [],
    getCoordinatorRun: () => undefined,
    updateCoordinatorRun: reached('updateCoordinatorRun'),
    createCoordinatorRun: reached('createCoordinatorRun'),
    resetAll: reached('resetAll'),
    resetTasks: reached('resetTasks'),
    resetMessages: reached('resetMessages'),
    capabilities: { mint: reached('mint') },
    ...dbOverrides
  }
  const runtime = {
    getOrchestrationDb: () => db,
    assertTerminalHandleInCallerScope: (handle: string) => {
      asked.push(handle)
      if (handle !== IN_SCOPE) {
        throw new CallerScopeDeniedError(`Refused: terminal ${handle}`)
      }
    },
    isTerminalHandleReachableByCaller: (handle: string) => handle === IN_SCOPE,
    assertWorkspaceSelectorInCallerScope: async (
      selector: string | undefined,
      subject: string
    ): Promise<void> => {
      asked.push(selector ?? '<no workspace>')
      if (selector !== IN_SCOPE_WT) {
        throw new CallerScopeDeniedError(`Refused: ${subject}`)
      }
    },
    // Why not a tripwire: send resolves the SENDER's pane before it looks at the
    // recipient at all, and that lookup is already bounded by the handle registry.
    getTerminalPaneKey: () => null,
    isTerminalRunningAgent: reached('isTerminalRunningAgent'),
    getPersonalizationPrompt: reached('getPersonalizationPrompt')
  }
  return { runtime, asked }
}

async function invoke(name: string, params: unknown, runtime: unknown): Promise<unknown> {
  const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`no such method: ${name}`)
  }
  return method.handler(params, { runtime } as unknown as RpcContext)
}

describe('orchestration point-to-point names its recipient', () => {
  it.each([
    ['orchestration.send', { to: 'term_local', subject: 's', body: 'b', type: 'note' }],
    ['orchestration.dispatch', { task: 'task_1', to: 'term_local', inject: true }],
    ['orchestration.ask', { to: 'term_local', question: 'q?' }]
  ])('%s refuses a recipient outside the caller scope before any write', async (name, params) => {
    const { runtime, asked } = createRuntime()
    await expect(runWithCallerScope(REMOTE, () => invoke(name, params, runtime))).rejects.toThrow(
      CallerScopeDeniedError
    )
    expect(asked).toEqual(['term_local'])
  })

  it('lets a peer on the caller own host through to the existing behavior', async () => {
    const { runtime, asked } = createRuntime()
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke(
          'orchestration.send',
          { to: IN_SCOPE, subject: 's', body: 'b', type: 'note' },
          runtime
        )
      )
    ).rejects.toThrow(/reached insertMessage/)
    expect(asked).toEqual([IN_SCOPE])
  })
})

// Why these too: send/dispatch/ask were guarded and the rest of the mail surface
// was not, which is the same omission at a smaller scale — a mailbox is named by
// `--terminal`, by a message id, or by a gate's origin, and reading one consumes
// it just as surely as sending writes to one.
describe('orchestration bounds every surface that names a mailbox', () => {
  it('check refuses a mailbox outside the caller scope before it marks anything read', async () => {
    const { runtime, asked } = createRuntime()
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.check', { terminal: 'term_local', unread: true }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(asked).toEqual(['term_local'])
  })

  it('reply refuses when the message it consumes belongs to another host', async () => {
    const { runtime, asked } = createRuntime({
      getMessageById: () => ({
        id: 'msg_1',
        to_handle: 'term_local',
        from_handle: IN_SCOPE,
        subject: 's'
      })
    })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.reply', { id: 'msg_1', body: 'b' }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(asked).toEqual(['term_local'])
  })

  it('reply refuses when the pane it would answer INTO belongs to another host', async () => {
    const { runtime, asked } = createRuntime({
      getMessageById: () => ({
        id: 'msg_1',
        to_handle: IN_SCOPE,
        from_handle: 'term_local',
        subject: 's'
      })
    })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.reply', { id: 'msg_1', body: 'b' }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(asked).toEqual([IN_SCOPE, 'term_local'])
  })

  it('inbox refuses a named mailbox and hides the rest of the mail catalog', async () => {
    const { runtime } = createRuntime({
      getInbox: () => [
        { id: 'm1', to_handle: IN_SCOPE, from_handle: IN_SCOPE },
        { id: 'm2', to_handle: 'term_local', from_handle: 'term_local' },
        { id: 'm3', to_handle: IN_SCOPE, from_handle: 'term_local' }
      ]
    })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.inbox', { terminal: 'term_local' }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
    const listed = (await runWithCallerScope(REMOTE, () =>
      invoke('orchestration.inbox', {}, runtime)
    )) as { messages: { id: string }[]; count: number }
    expect(listed.messages.map((message) => message.id)).toEqual(['m1'])
    expect(listed.count).toBe(1)
  })

  it('dispatchShow refuses before re-minting the assignee capability', async () => {
    const { runtime, asked } = createRuntime({
      getDispatchContext: () => ({
        id: 'ctx_1',
        assignee_handle: 'term_local',
        capability_hash: 'hash',
        status: 'active'
      })
    })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.dispatchShow', { task: 'task_1', preamble: true }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(asked).toEqual(['term_local'])
  })

  it('reset has no mailbox to bound, so a remote caller is refused outright', async () => {
    const { runtime } = createRuntime()
    await expect(
      runWithCallerScope(REMOTE, () => invoke('orchestration.reset', { all: true }, runtime))
    ).rejects.toThrow(/no host selector to bound/)
    await expect(invoke('orchestration.reset', { all: true }, runtime)).rejects.toThrow(
      /reached resetAll/
    )
  })
})

describe('orchestration bounds the coordinator surface that drives panes', () => {
  it('gateResolve refuses before resolving a gate whose asker is on another host', async () => {
    const { runtime, asked } = createRuntime({
      getGate: () => ({ id: 'gate_1', origin_message_id: 'msg_1' }),
      getMessageById: () => ({ id: 'msg_1', to_handle: IN_SCOPE, from_handle: 'term_local' })
    })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.gateResolve', { id: 'gate_1', resolution: 'yes' }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(asked).toEqual(['term_local'])
  })

  it('run refuses a coordinator that names no workspace, before it creates a run', async () => {
    const { runtime, asked } = createRuntime()
    await expect(
      runWithCallerScope(REMOTE, () => invoke('orchestration.run', { spec: 'do work' }, runtime))
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(asked).toEqual(['<no workspace>'])
  })

  it('runStop refuses to stop a coordinator loop belonging to another host', async () => {
    const { runtime, asked } = createRuntime({
      getActiveCoordinatorRuns: () => [{ id: 'run_1', coordinator_handle: 'term_local' }]
    })
    await expect(
      runWithCallerScope(REMOTE, () => invoke('orchestration.runStop', {}, runtime))
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(asked).toEqual(['term_local'])
  })

  it('runLog refuses to read another host coordinator diagnostics', async () => {
    const { runtime, asked } = createRuntime({
      getCoordinatorRun: () => ({ id: 'run_1', coordinator_handle: 'term_local' })
    })
    await expect(
      runWithCallerScope(REMOTE, () => invoke('orchestration.runLog', { runId: 'run_1' }, runtime))
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(asked).toEqual(['term_local'])
  })
})
