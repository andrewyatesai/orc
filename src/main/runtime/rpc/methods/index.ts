import { STATUS_METHODS } from './status'
import { AI_VAULT_METHODS } from './ai-vault'
import { AUTOMATION_METHODS } from './automations'
import { REPO_METHODS } from './repo'
import { WORKTREE_METHODS } from './worktree'
import { TERMINAL_METHODS } from './terminal'
import { TERMINAL_AWAIT_METHODS } from './terminal-await'
import { TERMINAL_CONTEXT_METHODS } from './terminal-context'
import { TERMINAL_RECORDING_METHODS } from './terminal-recording'
import { TERMINAL_SUBMIT_METHODS } from './terminal-submit'
import { FLEET_GRANT_METHODS } from './fleet-grant'
import { APP_MODE_METHODS } from './app-mode'
import { ALAB_CONSOLE_METHODS } from './alab-console'
import { TERMINAL_KEY_METHODS } from './terminal-key'
import { TERMINAL_ORPHAN_METHODS } from './terminal-orphan'
import { BROWSER_CORE_METHODS } from './browser-core'
import { BROWSER_EXTRA_METHODS } from './browser-extras'
import { BROWSER_SCREENCAST_METHODS } from './browser-screencast'
import {
  bindRpcMethodGroupsToCallerScope,
  browserCallerScopeGuard,
  callerScopeExempt,
  callerScopeGuardedBy,
  type RpcMethodGroupPolicies
} from './rpc-method-group-caller-scope'
import { ORCHESTRATION_METHODS } from './orchestration'
import { NOTIFICATION_METHODS } from './notifications'
import { STATS_METHODS } from './stats'
import { DIAGNOSTICS_METHODS } from './diagnostics'
import { ACCOUNT_METHODS } from './accounts'
import { PREFLIGHT_METHODS } from './preflight'
import { COMPUTER_METHODS } from './computer'
import { SESSION_TAB_METHODS } from './session-tabs'
import { NATIVE_CHAT_METHODS } from './native-chat'
import { FILE_METHODS } from './files'
import { GIT_METHODS } from './git'
import { GITHUB_METHODS } from './github'
import { GITLAB_METHODS } from './gitlab'
import { HOSTED_REVIEW_METHODS } from './hosted-review'
import { LINEAR_METHODS } from './linear'
import { LINEAR_AGENT_ACCESS_METHODS } from './linear-agent-access'
import { JIRA_METHODS } from './jira'
import { SSH_METHODS } from './ssh'
import { SPEECH_METHODS } from './speech'
import { CLIENT_UI_METHODS } from './client-ui'
import { CLIENT_EVENT_METHODS } from './client-events'
import { WORKSPACE_PORT_METHODS } from './workspace-ports'
import { SKILL_METHODS } from './skills'
import { CLIPBOARD_METHODS } from './clipboard'
import { HOST_CAPABILITY_METHODS } from './host-capabilities'
import { EMULATOR_METHODS } from './emulator'
import { PAIRING_METHODS } from './pairing'
import { UPDATER_METHODS } from './updater'
import { AGENT_SESSION_METHODS } from './agent-session'

// Why: a named manifest keeps registration order explicit and provides one
// grep-point for "what methods does the RPC server expose?" — and, since every
// group must appear here to exist, one place to bind the caller-scope bound to.
export const RPC_METHOD_GROUPS = {
  status: STATUS_METHODS,
  aiVault: AI_VAULT_METHODS,
  automation: AUTOMATION_METHODS,
  repo: REPO_METHODS,
  worktree: WORKTREE_METHODS,
  agentSession: AGENT_SESSION_METHODS,
  terminal: TERMINAL_METHODS,
  terminalAwait: TERMINAL_AWAIT_METHODS,
  terminalContext: TERMINAL_CONTEXT_METHODS,
  terminalRecording: TERMINAL_RECORDING_METHODS,
  terminalSubmit: TERMINAL_SUBMIT_METHODS,
  fleetGrant: FLEET_GRANT_METHODS,
  appMode: APP_MODE_METHODS,
  alabConsole: ALAB_CONSOLE_METHODS,
  terminalKey: TERMINAL_KEY_METHODS,
  terminalOrphan: TERMINAL_ORPHAN_METHODS,
  browser: [...BROWSER_CORE_METHODS, ...BROWSER_SCREENCAST_METHODS, ...BROWSER_EXTRA_METHODS],
  orchestration: ORCHESTRATION_METHODS,
  notification: NOTIFICATION_METHODS,
  stats: STATS_METHODS,
  diagnostics: DIAGNOSTICS_METHODS,
  account: ACCOUNT_METHODS,
  preflight: PREFLIGHT_METHODS,
  computer: COMPUTER_METHODS,
  sessionTab: SESSION_TAB_METHODS,
  nativeChat: NATIVE_CHAT_METHODS,
  file: FILE_METHODS,
  git: GIT_METHODS,
  github: GITHUB_METHODS,
  gitlab: GITLAB_METHODS,
  hostedReview: HOSTED_REVIEW_METHODS,
  linear: LINEAR_METHODS,
  linearAgentAccess: LINEAR_AGENT_ACCESS_METHODS,
  jira: JIRA_METHODS,
  ssh: SSH_METHODS,
  speech: SPEECH_METHODS,
  workspacePort: WORKSPACE_PORT_METHODS,
  skill: SKILL_METHODS,
  clipboard: CLIPBOARD_METHODS,
  hostCapability: HOST_CAPABILITY_METHODS,
  clientEvent: CLIENT_EVENT_METHODS,
  clientUi: CLIENT_UI_METHODS,
  emulator: EMULATOR_METHODS,
  pairing: PAIRING_METHODS,
  updater: UPDATER_METHODS
} as const

/**
 * Caller-scope policy per group. **Absence is the bound**: an unlisted group is
 * local-only, so a group added tomorrow is refused to remote callers on the day
 * it lands and opening it up is a reviewable line here, not a silent omission.
 *
 * Only the SSH-attributed CLI bridge is ever non-local (see runtime-caller-scope);
 * the renderer, local CLI and in-process callers are unaffected by every entry.
 *
 * Each reason below is a claim about EVERY method in its group, and five review
 * rounds each found methods it was false for. So no reason here is trusted: an
 * executed table in `caller-scope-exemption-audit.test.ts` drives every method
 * of every group listed here under a bounded caller and checks what each one
 * WRITES as well as what it answers, and a group added here without a table does
 * not compile.
 */
export const RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES = {
  status: callerScopeExempt(
    'the liveness handshake every remote command starts from: it names no host object, and answers with version, graph state, aggregate counts and the shell/workspace settings a client needs to negotiate — all of them properties of the machine running Orca rather than of any row it holds.'
  ),
  pairing: callerScopeExempt(
    'both methods mint or read relay credentials for the machine running Orca — a host object no selector names — so both are local-only in their handlers; only a paired-device socket carries a pairing context at all, but that is transport wiring, not a bound.'
  ),
  worktree: callerScopeExempt(
    'every selector resolves through the caller-bounded worktree and repo catalogs; ps/list/lineage take none and are filtered to what the caller reaches — ps scans instead of reading the catalog, so it also warms this runtime’s resolution cache and stamps the durable id a first sighting persists, host bookkeeping about rows the caller is never shown; the three paths that take ids instead of resolving a selector (forceDeleteBranch, the rm fallback for a worktree Git no longer lists, and persistSortOrder — which takes the whole ordering as raw ids) assert every id themselves; resolvePr/MrBase report a missing repo as data, so they re-raise a refusal rather than let it read as one.'
  ),
  agentSession: callerScopeExempt(
    'both methods name a worktree, resolved through the bounded worktree catalog; ensure’s automatic variant names a renderer sleep record instead and is refused outright, for everyone.'
  ),
  terminal: callerScopeExempt(
    'panes are addressed by handle or pane key, both bounded registries, and the roster is filtered; create/stop/sleep/stopExact name a worktree rather than a pane and resolve it through the bounded worktree catalog; unsubscribe names its pane through the subscription id it was issued, and tmuxCompat through the team’s leader pane — asserted before dispatch, because that path reports every throw as a tmux exit code; resolveActive names at most a worktree and never a pane, so with nothing named it refuses rather than fall back to whatever pane this machine has focused; the three that name no host object either (get/setAutoRestoreFit, one app-wide preference, and multiplex, which claims the connection’s binary channel) are local-only in their handlers; isRunningAgent answers false for any failed probe, so it re-raises a refusal rather than report the pane as agent-free.'
  ),
  terminalAwait: callerScopeExempt(
    'addresses every pane in its await set by handle — the bounded handle registry.'
  ),
  terminalContext: callerScopeExempt('addresses a pane by handle — the bounded handle registry.'),
  terminalSubmit: callerScopeExempt('addresses a pane by handle — the bounded handle registry.'),
  terminalKey: callerScopeExempt('addresses a pane by handle — the bounded handle registry.'),
  orchestration: callerScopeExempt(
    'mail is bounded per named recipient/mailbox and fan-out by group membership; every task, gate and run selector is bounded by the panes that row names (creator, assignee, coordinator, asker), and the four verbs that name nothing — inbox, taskList, gateList, runList — are filtered to those; an untargeted runStop refuses rather than pick a run the caller cannot see; runLog for a run with no durable row has no coordinator to bound it to and is local-only there; reset names nothing and is local-only outright.'
  ),
  linear: callerScopeExempt(
    'Linear is a cloud workspace, not a machine — these methods take no host selector at all.'
  ),
  linearAgentAccess: callerScopeExempt(
    'Linear is a cloud workspace, and the only host objects these name — the --current context terminal, worktree and cwd — resolve through the bounded handle registry and worktree catalog; the resolver falls back to cwd when a handle looks stale, so it re-raises a refusal instead of letting it read as staleness.'
  ),
  browser: callerScopeGuardedBy(
    browserCallerScopeGuard,
    'the worktree whose session the command drives IS the host selector; eval/exec stay local-only.'
  )
} satisfies RpcMethodGroupPolicies<typeof RPC_METHOD_GROUPS>

/**
 * Every group with a policy owes an executed per-method coverage table (see
 * `caller-scope-audit-test-harness`). Derived from the literal policy object on
 * purpose: a group exempted here without a table stops compiling, so the next
 * exemption cannot be a sentence nobody checked.
 */
export type CallerScopePoliciedGroup = keyof typeof RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES

export const ALL_RPC_METHODS = bindRpcMethodGroupsToCallerScope(
  RPC_METHOD_GROUPS,
  RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES
)
