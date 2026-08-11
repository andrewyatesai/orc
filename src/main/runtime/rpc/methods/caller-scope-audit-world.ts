/**
 * The world every caller-scope audit case runs against: one host, and it is not
 * the caller's. Every worktree, pane, task, gate, run and message in it belongs
 * to {@link AUDIT_OTHER_TARGET} and carries {@link AUDIT_SENTINEL}, so "the
 * reply held nothing of theirs" is something the suite can see rather than
 * something a reason asserts.
 *
 * Built on the real OrcaRuntimeService on purpose: the bound lives in the
 * catalogs and registries, so a hand-rolled runtime double would audit the
 * double. Only what reaches off-host — the Linear cloud, the orchestration
 * store — is stubbed, and stubbed to benign values, because a cloud row is not
 * a host object and must not read as one.
 *
 * Owning the whole world is also what lets {@link captureAuditHostState} answer
 * the other half of the question: not just what a method said, but what it
 * changed while saying it.
 */
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { AUDIT_OTHER_TARGET, AUDIT_SENTINEL } from './caller-scope-audit-test-harness'

export const OTHER_REPO = 'repo_other'
export const OTHER_WT = `${OTHER_REPO}::/home/me/other`
export const OTHER_HANDLE = 'term_other'
export const OTHER_LEAF_ID = '00000000-0000-4000-8000-000000000001'
export const OTHER_TAB_ID = 'tab_other'
export const OTHER_PANE_KEY = `${OTHER_TAB_ID}:${OTHER_LEAF_ID}`
/** The id `terminal.subscribe` would have issued for that pane: `<handle>[:<client>]`. */
export const OTHER_SUBSCRIPTION_ID = `${OTHER_HANDLE}:client_other`
const OTHER_CONNECTION_ID = 'conn_other'

const REPOS = [
  {
    id: OTHER_REPO,
    path: '/home/me/other',
    displayName: AUDIT_SENTINEL,
    connectionId: AUDIT_OTHER_TARGET
  }
]

const RESOLVED_WORKTREE = {
  id: OTHER_WT,
  repoId: OTHER_REPO,
  path: '/home/me/other',
  branch: AUDIT_SENTINEL,
  displayName: AUDIT_SENTINEL,
  linkedIssue: null,
  comment: AUDIT_SENTINEL
}

/** One task, gate, run and message, each owned by the pane the caller cannot reach. */
function createOrchestrationDb(): Record<string, unknown> {
  const task = {
    id: 'task_1',
    spec: AUDIT_SENTINEL,
    status: 'ready',
    created_by_terminal_handle: OTHER_HANDLE,
    run_id: 'run_1',
    assignee_handle: OTHER_HANDLE,
    dispatch_id: 'ctx_1'
  }
  const run = {
    id: 'run_1',
    spec: AUDIT_SENTINEL,
    status: 'running',
    coordinator_handle: OTHER_HANDLE
  }
  const gate = {
    id: 'gate_1',
    task_id: 'task_1',
    run_id: 'run_1',
    question: AUDIT_SENTINEL,
    options: ''
  }
  const message = {
    id: 'msg_1',
    to_handle: OTHER_HANDLE,
    from_handle: OTHER_HANDLE,
    subject: AUDIT_SENTINEL,
    body: AUDIT_SENTINEL
  }
  const reached = (what: string) => (): never => {
    throw new Error(`reached ${what}`)
  }
  return {
    getTask: () => task,
    getDispatchContext: () => ({
      id: 'ctx_1',
      assignee_handle: OTHER_HANDLE,
      status: 'active',
      capability_hash: AUDIT_SENTINEL
    }),
    getCoordinatorRun: () => run,
    getActiveCoordinatorRuns: () => [run],
    getMessageById: () => message,
    getInbox: () => [message],
    getAllMessagesForHandle: () => [message],
    getUnreadMessages: () => [message],
    getGate: () => gate,
    listGates: () => [gate],
    listTasks: () => [task],
    listTasksWithDispatch: () => [task],
    runs: { list: () => [run] },
    capabilities: { mint: reached('mint') },
    insertMessage: reached('insertMessage'),
    createDispatchContext: reached('createDispatchContext'),
    createTask: reached('createTask'),
    updateTaskStatus: reached('updateTaskStatus'),
    createGate: reached('createGate'),
    resolveGate: reached('resolveGate'),
    markAsRead: reached('markAsRead'),
    updateCoordinatorRun: reached('updateCoordinatorRun'),
    createCoordinatorRun: reached('createCoordinatorRun'),
    resetAll: reached('resetAll'),
    resetTasks: reached('resetTasks'),
    resetMessages: reached('resetMessages')
  }
}

/**
 * Linear reads answer benignly: a Linear issue belongs to a cloud workspace, not
 * to a machine, so it must not carry the sentinel — otherwise the audit would
 * read "reached Linear" as "reached another host". The resolvers that DO name
 * host objects are left real, and a Linear method that grows a host selector
 * later has to join them or its table row proves nothing.
 */
const LINEAR_HOST_RESOLVERS = new Set([
  'linearResolveCurrentIssue',
  'linearIssueContext',
  'linearSaveIssue',
  'linearIssueSetState',
  'linearIssueUpdateTask',
  'linearIssueRelationWrite',
  'linearIssueAddComment',
  'linearIssueAttachLink',
  'linearIssueCreate'
])

function stubLinearCloud(runtime: OrcaRuntimeService): void {
  const mutable = runtime as unknown as Record<string, unknown>
  for (const name of Object.getOwnPropertyNames(OrcaRuntimeService.prototype)) {
    if (name.startsWith('linear') && !LINEAR_HOST_RESOLVERS.has(name)) {
      mutable[name] = async (): Promise<unknown> => ({ linear: 'cloud row, no host' })
    }
  }
}

function registerOtherHostPane(runtime: OrcaRuntimeService): void {
  const internals = runtime as unknown as {
    handles: { set: (key: string, value: unknown) => unknown }
    leaves: { set: (key: string, value: unknown) => unknown }
    handleByLeafKey: Map<string, string>
    handleByPtyId: Map<string, string>
    paneKeyByHandleMemory: Map<string, string>
  }
  internals.handles.set(OTHER_HANDLE, {
    handle: OTHER_HANDLE,
    runtimeId: runtime.getRuntimeId(),
    rendererGraphEpoch: 0,
    worktreeId: OTHER_WT,
    tabId: OTHER_TAB_ID,
    leafId: OTHER_LEAF_ID,
    ptyId: `pty_${OTHER_HANDLE}`,
    ptyGeneration: 0
  })
  internals.leaves.set(`${OTHER_TAB_ID}::${OTHER_LEAF_ID}`, {
    tabId: OTHER_TAB_ID,
    leafId: OTHER_LEAF_ID,
    worktreeId: OTHER_WT,
    ptyId: `pty_${OTHER_HANDLE}`,
    ptyGeneration: 0,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: AUDIT_SENTINEL,
    tailBuffer: [AUDIT_SENTINEL],
    tailTranscriptBuffer: [AUDIT_SENTINEL],
    tailLinesTotal: 1,
    tailTruncated: false,
    paneRuntimeId: 1
  })
  // Why both indexes: the runtime mints a handle for any leaf that has none, so a
  // half-registered pane would make every roster read look like a mutation.
  internals.handleByLeafKey.set(`${OTHER_TAB_ID}::${OTHER_LEAF_ID}`, OTHER_HANDLE)
  internals.handleByPtyId.set(`pty_${OTHER_HANDLE}`, OTHER_HANDLE)
  internals.paneKeyByHandleMemory.set(OTHER_HANDLE, OTHER_PANE_KEY)
  // Why a live stream and not just a pane: tearing one down writes nothing to the
  // reply, so without a subscription to lose, a teardown of the other host's pane
  // would leave the world identical to one where the method did nothing.
  runtime.registerSubscriptionCleanup(OTHER_SUBSCRIPTION_ID, () => undefined, OTHER_CONNECTION_ID)
}

export function createAuditRuntime(): OrcaRuntimeService {
  const lineage = {
    [OTHER_WT]: { parentWorktreeId: OTHER_WT, note: AUDIT_SENTINEL }
  }
  const store = {
    // Why a log and not a no-op: a write that only persists would leave no trace
    // in memory, and "the reply held nothing of theirs" would pass over it.
    writes: [] as string[],
    getRepos: () => REPOS,
    getRepo: (id: string) => REPOS.find((repo) => repo.id === id),
    getFolderWorkspaces: () => [],
    getWorktreeMeta: () => ({ comment: AUDIT_SENTINEL }),
    getAllWorktreeMeta: () => ({ [OTHER_WT]: { comment: AUDIT_SENTINEL } }),
    setWorktreeMeta: (...args: unknown[]) => {
      store.writes.push(`setWorktreeMeta ${JSON.stringify(args)}`)
    },
    getSettings: () => ({}),
    getAllWorktreeLineage: () => lineage,
    getAllWorkspaceLineage: () => lineage,
    listAutomations: () => [],
    getProjects: () => [],
    getProjectHostSetups: () => []
  }
  const runtime = new OrcaRuntimeService(store as never)
  const mutable = runtime as unknown as Record<string, unknown>
  mutable.listAllResolvedWorktrees = async () => [RESOLVED_WORKTREE]
  mutable.getOrchestrationDb = () => createOrchestrationDb()
  // Why: a graph that is not ready refuses everything with runtime_unavailable,
  // which would read as a bound while proving nothing.
  mutable.graphStatus = 'ready'
  // Why: the fleet experiment gate is an orthogonal switch a user can turn on,
  // so leaving it closed would hide whether the caller bound holds behind it.
  mutable.assertFleetVerbEnabled = () => undefined
  mutable.assertFleetWriteGrant = () => undefined
  // Why a tripwire and not a stub: terminal.create checks for a spawner before
  // it resolves the workspace, so without one the audit would read a missing
  // fixture as a bound.
  mutable.ptyController = {
    spawn: (): never => {
      throw new Error('reached pty spawn')
    }
  }
  stubLinearCloud(runtime)
  registerOtherHostPane(runtime)
  return runtime
}

export function createAuditContext(): RpcContext {
  return {
    runtime: createAuditRuntime(),
    pairing: {
      getEndpoints: async () => ({ endpoints: [AUDIT_SENTINEL] }),
      provisionRelay: async () => ({ relay: AUDIT_SENTINEL })
    }
  } as unknown as RpcContext
}

const DIGEST_DEPTH = 8

/** Wall-clock and scheduler bookkeeping churns on its own; a diff in it is noise. */
function volatileKind(value: object): string | null {
  if (value instanceof Promise) {
    return 'promise'
  }
  const constructor = value.constructor?.name
  return constructor === 'Timeout' || constructor === 'Immediate' ? 'timer' : null
}

function digestValue(value: unknown, depth: number, seen: Set<object>): string {
  if (typeof value === 'function') {
    return 'fn'
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? `${value}n` : (JSON.stringify(value) ?? 'undefined')
  }
  if (seen.has(value)) {
    return 'cycle'
  }
  const volatile = volatileKind(value)
  if (volatile) {
    return volatile
  }
  if (depth === 0) {
    return 'depth-capped'
  }
  seen.add(value)
  if (value instanceof Map) {
    return `map{${[...value]
      .map(([key, entry]) => `${String(key)}=${digestValue(entry, depth - 1, seen)}`)
      .sort()
      .join(',')}}`
  }
  if (value instanceof Set) {
    return `set{${[...value]
      .map((entry) => digestValue(entry, depth - 1, seen))
      .sort()
      .join(',')}}`
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => digestValue(entry, depth - 1, seen)).join(',')}]`
  }
  return `{${Object.entries(value)
    .map(([key, entry]) => `${key}=${digestValue(entry, depth - 1, seen)}`)
    .sort()
    .join(',')}}`
}

/**
 * Every mutable field the runtime owns, digested field by field so a diff names
 * the one that moved. Walked reflectively rather than from a list of the
 * registries that seemed to matter: such a list is the same checklist that went
 * stale five rounds running, and the sixth miss was a write nobody had listed.
 *
 * Persistence is covered because the store keeps a write log the walk reaches;
 * the orchestration db needs no entry because every writer on it is a tripwire.
 * The walk is depth-capped, so this catches a write, not every conceivable one.
 */
export function captureAuditHostState(ctx: RpcContext): Record<string, string> {
  const state: Record<string, string> = {}
  for (const [field, value] of Object.entries(ctx.runtime as unknown as Record<string, unknown>)) {
    state[field] = digestValue(value, DIGEST_DEPTH, new Set())
  }
  return state
}
