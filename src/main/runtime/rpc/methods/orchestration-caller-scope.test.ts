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
function createRuntime(
  dbOverrides: Record<string, unknown> = {},
  runtimeOverrides: Record<string, unknown> = {}
): {
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
    getPersonalizationPrompt: reached('getPersonalizationPrompt'),
    ...runtimeOverrides
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
    // Why the refusal names nothing: the caller named nothing, so the fallback it
    // was refused is not its business — the run id and handle stay unspoken.
    await expect(
      runWithCallerScope(REMOTE, () => invoke('orchestration.runStop', {}, runtime))
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(asked).toEqual([])
  })

  it('runStop names a run it was handed, rather than hiding it as not found', async () => {
    const { runtime, asked } = createRuntime({
      getActiveCoordinatorRuns: () => [{ id: 'run_1', coordinator_handle: 'term_local' }]
    })
    await expect(
      runWithCallerScope(REMOTE, () => invoke('orchestration.runStop', { runId: 'run_1' }, runtime))
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(asked).toEqual(['term_local'])
  })

  it('runStop still stops the caller own run when another host has one live too', async () => {
    let stopped: string | undefined
    const { runtime } = createRuntime({
      getActiveCoordinatorRuns: () => [
        { id: 'run_local', coordinator_handle: 'term_local' },
        { id: 'run_mine', coordinator_handle: IN_SCOPE }
      ],
      updateCoordinatorRun: (runId: string) => {
        stopped = runId
      }
    })
    await expect(
      runWithCallerScope(REMOTE, () => invoke('orchestration.runStop', {}, runtime))
    ).resolves.toEqual({ runId: 'run_mine', stopped: true })
    expect(stopped).toBe('run_mine')
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

  it('runLog refuses an in-memory tail no run row can attribute', async () => {
    const { runtime } = createRuntime()
    await expect(
      runWithCallerScope(REMOTE, () => invoke('orchestration.runLog', { runId: 'run_1' }, runtime))
    ).rejects.toThrow(/no host selector to bound/)
  })
})

// Why these: the task, gate and run tables are workspace-wide, so a row is
// reachable only through the panes it names — creator, assignee, coordinator.
// A row that names none is hidden from a bounded caller, not handed over.
const MINE = {
  id: 'task_mine',
  spec: 'mine',
  status: 'ready',
  created_by_terminal_handle: IN_SCOPE,
  run_id: null,
  assignee_handle: null,
  dispatch_id: null
}
const THEIRS = {
  id: 'task_theirs',
  spec: 'theirs',
  status: 'ready',
  created_by_terminal_handle: 'term_local',
  run_id: null,
  assignee_handle: null,
  dispatch_id: null
}

describe('orchestration filters the task, gate and run catalogs', () => {
  it('taskList hides tasks whose panes the caller cannot reach', async () => {
    const { runtime } = createRuntime({ listTasksWithDispatch: () => [MINE, THEIRS] })
    const listed = (await runWithCallerScope(REMOTE, () =>
      invoke('orchestration.taskList', {}, runtime)
    )) as { tasks: { id: string }[]; count: number }
    expect(listed.tasks.map((task) => task.id)).toEqual(['task_mine'])
    expect(listed.count).toBe(1)
  })

  it('taskList reaches a task through its assignee and through its run coordinator', async () => {
    const byAssignee = { ...THEIRS, id: 'task_a', assignee_handle: IN_SCOPE }
    const byRun = { ...THEIRS, id: 'task_r', run_id: 'run_mine' }
    const { runtime } = createRuntime({
      listTasksWithDispatch: () => [byAssignee, byRun, THEIRS],
      getCoordinatorRun: (runId: string) =>
        runId === 'run_mine' ? { id: runId, coordinator_handle: IN_SCOPE } : undefined
    })
    const listed = (await runWithCallerScope(REMOTE, () =>
      invoke('orchestration.taskList', {}, runtime)
    )) as { tasks: { id: string }[] }
    expect(listed.tasks.map((task) => task.id)).toEqual(['task_a', 'task_r'])
  })

  it('gateList hides gates whose task belongs to another host', async () => {
    const { runtime } = createRuntime({
      getTask: (id: string) => (id === MINE.id ? MINE : THEIRS),
      listGates: () => [
        { id: 'gate_mine', task_id: MINE.id, run_id: null, question: 'ok?' },
        { id: 'gate_theirs', task_id: THEIRS.id, run_id: null, question: 'secret?' }
      ]
    })
    const listed = (await runWithCallerScope(REMOTE, () =>
      invoke('orchestration.gateList', {}, runtime)
    )) as { gates: { id: string }[]; count: number }
    expect(listed.gates.map((gate) => gate.id)).toEqual(['gate_mine'])
    expect(listed.count).toBe(1)
  })

  it('runList hides runs coordinated from another host but keeps the page window', async () => {
    const { runtime } = createRuntime({
      runs: {
        list: () => [
          { id: 'run_mine', coordinator_handle: IN_SCOPE, spec: 'mine' },
          { id: 'run_theirs', coordinator_handle: 'term_local', spec: 'theirs' }
        ]
      },
      listTasks: () => [],
      listGates: () => []
    })
    const listed = (await runWithCallerScope(REMOTE, () =>
      invoke('orchestration.runList', {}, runtime)
    )) as { runs: { id: string }[]; count: number; hasMore: boolean }
    expect(listed.runs.map((run) => run.id)).toEqual(['run_mine'])
    expect(listed.count).toBe(1)
    expect(listed.hasMore).toBe(false)
  })

  it('a local caller still sees every row', async () => {
    const { runtime } = createRuntime({ listTasksWithDispatch: () => [MINE, THEIRS] })
    const listed = (await invoke('orchestration.taskList', {}, runtime)) as {
      tasks: { id: string }[]
    }
    expect(listed.tasks.map((task) => task.id)).toEqual(['task_mine', 'task_theirs'])
  })
})

describe('orchestration bounds every surface that names a task', () => {
  it('dispatch --dry-run refuses before it reads the spec into a preamble', async () => {
    const { runtime } = createRuntime({ getTask: () => THEIRS })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.dispatch', { task: THEIRS.id, dryRun: true }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('dispatch --dry-run still previews a task the caller owns', async () => {
    const { runtime } = createRuntime(
      { getTask: () => MINE },
      {
        getPersonalizationPrompt: async () => undefined,
        getTerminalOrchestrationCliCommand: () => 'orca'
      }
    )
    const preview = (await runWithCallerScope(REMOTE, () =>
      invoke('orchestration.dispatch', { task: MINE.id, to: IN_SCOPE, dryRun: true }, runtime)
    )) as { dryRun: boolean; preamble: string }
    expect(preview.dryRun).toBe(true)
    expect(preview.preamble).toContain('mine')
  })

  it('taskUpdate refuses to move a task on another host', async () => {
    const { runtime } = createRuntime({
      getTask: () => THEIRS,
      updateTaskStatus: () => {
        throw new Error('reached updateTaskStatus')
      }
    })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.taskUpdate', { id: THEIRS.id, status: 'completed' }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('taskCreate refuses a bounded caller that names no creating terminal', async () => {
    const { runtime } = createRuntime({
      createTask: () => {
        throw new Error('reached createTask')
      }
    })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.taskCreate', { spec: 'work' }, runtime)
      )
    ).rejects.toThrow(/no host selector to bound/)
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke(
          'orchestration.taskCreate',
          { spec: 'work', callerTerminalHandle: 'term_local' },
          runtime
        )
      )
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('gateCreate refuses to block a task on another host', async () => {
    const { runtime } = createRuntime({
      getTask: () => THEIRS,
      createGate: () => {
        throw new Error('reached createGate')
      }
    })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.gateCreate', { task: THEIRS.id, question: 'q?' }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('gateResolve refuses a gate with no asker, which only its task can bound', async () => {
    const { runtime } = createRuntime({
      getTask: () => THEIRS,
      getGate: () => ({ id: 'gate_1', task_id: THEIRS.id, run_id: null, origin_message_id: null })
    })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.gateResolve', { id: 'gate_1', resolution: 'yes' }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('dispatchShow refuses to regenerate the preamble of an undispatched task', async () => {
    const { runtime } = createRuntime({
      getTask: () => THEIRS,
      getDispatchContext: () => undefined
    })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.dispatchShow', { task: THEIRS.id, preamble: true }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
  })

  it('ask refuses to open a gate on another host task even for a reachable recipient', async () => {
    const { runtime, asked } = createRuntime({ getTask: () => THEIRS })
    await expect(
      runWithCallerScope(REMOTE, () =>
        invoke('orchestration.ask', { to: IN_SCOPE, question: 'q?', task: THEIRS.id }, runtime)
      )
    ).rejects.toThrow(CallerScopeDeniedError)
    expect(asked).toEqual([IN_SCOPE])
  })
})

// Why the enumerated table moved: it now lives in caller-scope-exemption-audit,
// which runs the same two-answer table over EVERY policied group. The narrative
// cases above stay here — they say which object each refusal named, which a
// pass/fail table cannot.
