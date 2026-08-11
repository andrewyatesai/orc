import { describe, expect, it, vi } from 'vitest'
import type { RpcAnyMethod } from '../core'
import {
  ALL_RPC_METHODS,
  RPC_METHOD_GROUPS,
  RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES,
  type CallerScopePoliciedGroup
} from './index'
import {
  auditCallerScopeGroup,
  REFUSES,
  WITHHOLDS,
  WITHHOLDS_AND_WRITES,
  type CallerScopeGroupAudit
} from './caller-scope-audit-test-harness'
import {
  captureAuditHostState,
  createAuditContext,
  OTHER_HANDLE,
  OTHER_PANE_KEY,
  OTHER_REPO,
  OTHER_SUBSCRIPTION_ID,
  OTHER_WT
} from './caller-scope-audit-world'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WT = `id:${OTHER_WT}`
const PANE = { terminal: OTHER_HANDLE }
/** `--current` pointing at the other host's pane: the one host object Linear names. */
const CURRENT = { current: true, context: { terminalHandle: OTHER_HANDLE } }
/** `<13 digits>-<32 hex>`: anything else is rejected before the bound is reached. */
const OPERATION_ID = `${Date.now()}-${'a'.repeat(32)}`

/** Drives what the registry exposes, not the raw group: for a guarded group the
 *  wrapper IS the bound, and auditing the unwrapped export would audit nothing. */
function registered(group: keyof typeof RPC_METHOD_GROUPS): readonly RpcAnyMethod[] {
  return RPC_METHOD_GROUPS[group].map((method) => {
    const bound = ALL_RPC_METHODS.find((candidate) => candidate.name === method.name)
    if (!bound) {
      throw new Error(`group method missing from the registry: ${method.name}`)
    }
    return bound
  })
}

function table(
  group: keyof typeof RPC_METHOD_GROUPS,
  cases: CallerScopeGroupAudit['cases']
): CallerScopeGroupAudit {
  return {
    methods: registered(group),
    createContext: createAuditContext,
    captureHostState: captureAuditHostState,
    cases
  }
}

/**
 * Generated rather than spelled out, and safe to generate: these groups exist to
 * address one pane by handle, so the claim is uniform and the PARAMS carry it —
 * every method is handed another host's handle plus the few extra fields its
 * siblings need. A method that stopped naming a pane would ignore the handle and
 * answer, which is the failure. Extra keys are noise the schemas drop.
 */
function paneTable(group: keyof typeof RPC_METHOD_GROUPS): CallerScopeGroupAudit {
  return table(
    group,
    Object.fromEntries(
      registered(group).map((method) => [
        method.name,
        { params: { ...PANE, prompt: 'p', key: 'Enter', terminals: [PANE] }, answer: REFUSES }
      ])
    )
  )
}

const STATUS = table('status', {
  'status.get': { params: null, answer: WITHHOLDS }
})

const PAIRING = table('pairing', {
  'pairing.getEndpoints': { params: {}, answer: REFUSES },
  'pairing.provisionRelay': {
    params: { reqId: 'req_other', newResumeTokenHash: 'a'.repeat(43) },
    answer: REFUSES
  }
})

const WORKTREE = table('worktree', {
  // The one read here that scans rather than reads a catalog: it warms the
  // runtime's own resolution cache and stamps the durable instance id a worktree
  // gets on first sighting. Both are host bookkeeping about rows this caller is
  // never shown — but they are writes, so the row says so.
  'worktree.ps': {
    params: {},
    answer: WITHHOLDS_AND_WRITES,
    writes: ['resolvedWorktreeCache', 'store']
  },
  'worktree.list': { params: {}, answer: WITHHOLDS },
  'worktree.detectedList': { params: { repo: OTHER_REPO }, answer: REFUSES },
  'worktree.lineageList': { params: null, answer: WITHHOLDS },
  'worktree.show': { params: { worktree: WT }, answer: REFUSES },
  'worktree.sleep': { params: { worktree: WT }, answer: REFUSES },
  'worktree.activate': { params: { worktree: WT }, answer: REFUSES },
  'worktree.create': { params: { repo: OTHER_REPO }, answer: REFUSES },
  'worktree.prefetchCreateBase': { params: { repo: OTHER_REPO }, answer: REFUSES },
  'worktree.set': { params: { worktree: WT, comment: 'c' }, answer: REFUSES },
  'worktree.persistSortOrder': { params: { orderedIds: [OTHER_WT] }, answer: REFUSES },
  'worktree.resolvePrBase': { params: { repo: OTHER_REPO, prNumber: 1 }, answer: REFUSES },
  'worktree.resolveMrBase': { params: { repo: OTHER_REPO, mrIid: 1 }, answer: REFUSES },
  'worktree.rm': { params: { worktree: WT }, answer: REFUSES },
  'worktree.forceDeleteBranch': {
    params: { worktree: WT, branchName: 'b', expectedHead: 'a'.repeat(40) },
    answer: REFUSES
  }
})

const AGENT_SESSION = table('agentSession', {
  'terminal.ensureAgentSession': {
    params: {
      kind: 'explicit',
      worktree: WT,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess_1' }
    },
    answer: REFUSES
  },
  'terminal.createAgentSession': {
    params: { clientOperationId: OPERATION_ID, worktree: WT, agent: 'claude' },
    answer: REFUSES
  }
})

const TERMINAL = table('terminal', {
  'terminal.search': { params: { ...PANE, query: 'q' }, answer: REFUSES },
  'terminal.searchContext': { params: { ...PANE, hostRow: 1 }, answer: REFUSES },
  'terminal.list': { params: {}, answer: WITHHOLDS },
  'terminal.resolveActive': { params: {}, answer: REFUSES },
  'terminal.resolvePane': { params: { paneKey: OTHER_PANE_KEY }, answer: REFUSES },
  'terminal.recoverPane': {
    params: { paneKey: OTHER_PANE_KEY, worktreeId: OTHER_WT },
    answer: REFUSES
  },
  'terminal.show': { params: PANE, answer: REFUSES },
  'terminal.read': { params: PANE, answer: REFUSES },
  'terminal.inspectProcess': { params: PANE, answer: REFUSES },
  'terminal.isRunningAgent': { params: PANE, answer: REFUSES },
  'terminal.agentStatus': { params: PANE, answer: REFUSES },
  'terminal.rename': { params: { ...PANE, title: 't' }, answer: REFUSES },
  'terminal.clearBuffer': { params: PANE, answer: REFUSES },
  'terminal.send': { params: { ...PANE, text: 'x' }, answer: REFUSES },
  'terminal.wait': { params: { ...PANE, for: 'exit' }, answer: REFUSES },
  'terminal.create': { params: { worktree: WT }, answer: REFUSES },
  'terminal.split': { params: PANE, answer: REFUSES },
  'terminal.stop': { params: { worktree: WT }, answer: REFUSES },
  'terminal.sleep': { params: { worktree: WT }, answer: REFUSES },
  'terminal.stopExact': { params: { worktree: WT, expectedPtyIds: ['pty_1'] }, answer: REFUSES },
  'terminal.resizeForClient': {
    params: { ...PANE, mode: 'restore', clientId: 'c' },
    answer: REFUSES
  },
  'terminal.focus': { params: PANE, answer: REFUSES },
  'terminal.close': { params: PANE, answer: REFUSES },
  'terminal.closeTab': { params: PANE, answer: REFUSES },
  'agentTeams.tmuxCompat': {
    params: { teamId: 'team_1', token: 'tok', envPane: '%1', argv: ['list-panes'] },
    answer: REFUSES
  },
  'agentTeams.prepareLaunch': { params: { paneKey: OTHER_PANE_KEY }, answer: REFUSES },
  'terminal.setDisplayMode': { params: { ...PANE, mode: 'auto' }, answer: REFUSES },
  'terminal.restoreFit': { params: PANE, answer: REFUSES },
  'terminal.getDisplayMode': { params: PANE, answer: REFUSES },
  'terminal.updateViewport': {
    params: { ...PANE, client: { id: 'c' }, viewport: { cols: 80, rows: 24 } },
    answer: REFUSES
  },
  'terminal.multiplex': { params: {}, answer: REFUSES },
  'terminal.subscribe': { params: PANE, answer: REFUSES },
  // The id of a stream the world actually holds, so a refusal that came from an
  // unknown id rather than from the bound would show as a passing row here.
  'terminal.unsubscribe': { params: { subscriptionId: OTHER_SUBSCRIPTION_ID }, answer: REFUSES },
  'terminal.getAutoRestoreFit': { params: {}, answer: REFUSES },
  'terminal.setAutoRestoreFit': { params: { ms: 5000 }, answer: REFUSES }
})

const LINEAR = table('linear', {
  'linear.connect': { params: { apiKey: 'k' }, answer: WITHHOLDS },
  'linear.disconnect': { params: {}, answer: WITHHOLDS },
  'linear.selectWorkspace': { params: { workspaceId: 'w' }, answer: WITHHOLDS },
  'linear.status': { params: null, answer: WITHHOLDS },
  'linear.testConnection': { params: {}, answer: WITHHOLDS },
  'linear.searchIssues': { params: { query: 'q' }, answer: WITHHOLDS },
  'linear.listIssues': { params: {}, answer: WITHHOLDS },
  'linear.mcpListIssues': { params: {}, answer: WITHHOLDS },
  'linear.createIssue': { params: { teamId: 't', title: 'x' }, answer: WITHHOLDS },
  'linear.getIssue': { params: { id: 'i' }, answer: WITHHOLDS },
  'linear.updateIssue': { params: { id: 'i', updates: {} }, answer: WITHHOLDS },
  'linear.addIssueComment': { params: { issueId: 'i', body: 'b' }, answer: WITHHOLDS },
  'linear.issueComments': { params: { issueId: 'i' }, answer: WITHHOLDS },
  'linear.listTeams': { params: {}, answer: WITHHOLDS },
  'linear.listProjects': { params: {}, answer: WITHHOLDS },
  'linear.createProject': { params: { name: 'n', teamIds: ['t'] }, answer: WITHHOLDS },
  'linear.getProject': { params: { id: 'p', workspaceId: 'w' }, answer: WITHHOLDS },
  'linear.listProjectIssues': { params: { projectId: 'p', workspaceId: 'w' }, answer: WITHHOLDS },
  'linear.listCustomViews': { params: { model: 'issue' }, answer: WITHHOLDS },
  'linear.getCustomView': {
    params: { viewId: 'v', workspaceId: 'w', model: 'issue' },
    answer: WITHHOLDS
  },
  'linear.listCustomViewIssues': { params: { viewId: 'v', workspaceId: 'w' }, answer: WITHHOLDS },
  'linear.listCustomViewProjects': { params: { viewId: 'v', workspaceId: 'w' }, answer: WITHHOLDS },
  'linear.teamStates': { params: { teamId: 't' }, answer: WITHHOLDS },
  'linear.teamLabels': { params: { teamId: 't' }, answer: WITHHOLDS },
  'linear.teamMembers': { params: { teamId: 't' }, answer: WITHHOLDS }
})

const LINEAR_AGENT_ACCESS = table('linearAgentAccess', {
  'linear.saveIssue': { params: { ...CURRENT, title: 't' }, answer: REFUSES },
  'linear.agentSearchIssues': { params: { query: 'q' }, answer: WITHHOLDS },
  'linear.issueContext': {
    params: {
      ...CURRENT,
      include: { comments: false, children: false, attachments: false, relations: false },
      depth: 0
    },
    answer: REFUSES
  },
  'linear.agentTeamList': { params: {}, answer: WITHHOLDS },
  'linear.agentTeamMembers': { params: { teamInput: 't' }, answer: WITHHOLDS },
  'linear.agentTeamStates': { params: { teamInput: 't' }, answer: WITHHOLDS },
  'linear.agentTeamLabels': { params: { teamInput: 't' }, answer: WITHHOLDS },
  'linear.agentIssueList': { params: {}, answer: WITHHOLDS },
  'linear.agentProjectList': { params: {}, answer: WITHHOLDS },
  'linear.resolveCurrentIssue': { params: CURRENT.context, answer: REFUSES },
  'linear.issueSetState': { params: { ...CURRENT, to: 'done' }, answer: REFUSES },
  'linear.issueUpdateTask': { params: { ...CURRENT, operation: 'priority' }, answer: REFUSES },
  'linear.issueRelationWrite': {
    params: { ...CURRENT, relatedInput: 'ORC-2', relationship: 'blocks', operation: 'add' },
    answer: REFUSES
  },
  'linear.issueAddComment': { params: { ...CURRENT, body: 'b' }, answer: REFUSES },
  'linear.issueAttachLink': { params: { ...CURRENT, url: 'https://x' }, answer: REFUSES },
  'linear.issueCreate': {
    params: { title: 't', parentCurrent: true, context: CURRENT.context },
    answer: REFUSES
  }
})

const ORCHESTRATION = table('orchestration', {
  'orchestration.send': { params: { to: OTHER_HANDLE, subject: 's' }, answer: REFUSES },
  'orchestration.check': { params: { terminal: OTHER_HANDLE, unread: true }, answer: REFUSES },
  'orchestration.reply': { params: { id: 'msg_1', body: 'b' }, answer: REFUSES },
  'orchestration.inbox': { params: {}, answer: WITHHOLDS },
  'orchestration.taskCreate': { params: { spec: 's' }, answer: REFUSES },
  'orchestration.taskList': { params: {}, answer: WITHHOLDS },
  'orchestration.taskUpdate': { params: { id: 'task_1', status: 'completed' }, answer: REFUSES },
  'orchestration.dispatch': { params: { task: 'task_1', dryRun: true }, answer: REFUSES },
  'orchestration.dispatchShow': { params: { task: 'task_1', preamble: true }, answer: REFUSES },
  'orchestration.ask': { params: { to: OTHER_HANDLE, question: 'q?' }, answer: REFUSES },
  'orchestration.run': { params: { spec: 'work' }, answer: REFUSES },
  'orchestration.runStop': { params: {}, answer: REFUSES },
  'orchestration.gateCreate': { params: { task: 'task_1', question: 'q?' }, answer: REFUSES },
  'orchestration.gateResolve': { params: { id: 'gate_1', resolution: 'y' }, answer: REFUSES },
  'orchestration.runLog': { params: { runId: 'run_1' }, answer: REFUSES },
  'orchestration.gateList': { params: {}, answer: WITHHOLDS },
  'orchestration.runList': { params: {}, answer: WITHHOLDS },
  'orchestration.reset': { params: { all: true }, answer: REFUSES }
})

/**
 * Every required field the browser schemas name, in one object. Spelled out this
 * way because the group is uniform in what matters — no method here takes the
 * `worktree` the guard bounds on — while its schemas each demand a different
 * required field, and a row the schema would reject drives a call no caller can
 * make. Extra keys are noise these schemas drop.
 */
const BROWSER_REQUIRED_FIELDS = {
  element: 'e',
  selector: 'e',
  url: 'https://example.test',
  challengeId: 'c',
  value: 'v',
  input: 'i',
  text: 't',
  direction: 'down',
  expression: '1',
  page: 'p',
  profileId: 'prof',
  label: 'l',
  scope: 'isolated',
  browserFamily: 'chrome',
  from: 'a',
  to: 'b',
  files: ['/tmp/f'],
  key: 'Enter',
  what: 'text',
  locator: 'role',
  action: 'click',
  command: 'ls',
  path: '/tmp/f',
  subscriptionId: 'sub',
  name: 'n',
  width: 800,
  height: 600,
  latitude: 1,
  longitude: 2,
  x: 1,
  y: 2,
  dy: 1,
  headers: '{}',
  user: 'u',
  pass: 'p'
}

// Why generated and not spelled out: the browser group is WRAPPED, so the bound
// is registration rather than a per-method claim — but a wrapper that skips one
// method is exactly the failure this table exists to catch, so every method is
// still driven.
const BROWSER = table(
  'browser',
  Object.fromEntries(
    registered('browser').map((method) => [
      method.name,
      { params: BROWSER_REQUIRED_FIELDS, answer: REFUSES }
    ])
  )
)

/**
 * The registry, keyed by the literal policy object: a group exempted or guarded
 * in index.ts without a table here fails to compile, so the next exemption
 * cannot skip its coverage the way five rounds of them did.
 */
const CALLER_SCOPE_AUDITS: Record<CallerScopePoliciedGroup, CallerScopeGroupAudit> = {
  status: STATUS,
  pairing: PAIRING,
  worktree: WORKTREE,
  agentSession: AGENT_SESSION,
  terminal: TERMINAL,
  terminalAwait: paneTable('terminalAwait'),
  terminalContext: paneTable('terminalContext'),
  terminalSubmit: paneTable('terminalSubmit'),
  terminalKey: paneTable('terminalKey'),
  orchestration: ORCHESTRATION,
  linear: LINEAR,
  linearAgentAccess: LINEAR_AGENT_ACCESS,
  browser: BROWSER
}

describe('every policied RPC group is audited method by method', () => {
  it('audits exactly the groups whose caller-scope policy claims something', () => {
    expect(Object.keys(CALLER_SCOPE_AUDITS).sort()).toEqual(
      Object.keys(RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES).sort()
    )
  })

  // Why here and not in the harness: the dispatcher validates params before it
  // calls any handler, so a row the schema rejects drives a call that can never
  // arrive and its answer says nothing about the bound. 54 rows did.
  it('drives every row with params the dispatcher would have accepted', () => {
    const unreachable: string[] = []
    for (const audit of Object.values(CALLER_SCOPE_AUDITS)) {
      for (const [name, testCase] of Object.entries(audit.cases)) {
        const schema = audit.methods.find((candidate) => candidate.name === name)?.params
        const rejected = schema?.safeParse(testCase.params)
        if (rejected && !rejected.success) {
          unreachable.push(`${name}: ${rejected.error.issues[0]?.message}`)
        }
      }
    }
    expect(unreachable).toEqual([])
  })

  // Why the other groups owe nothing: the registry holds a WRAPPER for them, not
  // their own method object, so their bound is registration and there is no
  // per-method claim a table could check. A raw object reaching the registry is
  // how that stops being true.
  it('leaves every unpolicied group wrapped, with no table to maintain', () => {
    const passedThroughUnwrapped = Object.entries(RPC_METHOD_GROUPS)
      .filter(([group]) => !(group in RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES))
      .filter(([, methods]) => methods.some((method) => ALL_RPC_METHODS.includes(method as never)))
      .map(([group]) => group)
    expect(passedThroughUnwrapped).toEqual([])
  })
})

for (const [group, audit] of Object.entries(CALLER_SCOPE_AUDITS)) {
  auditCallerScopeGroup(group, audit)
}
