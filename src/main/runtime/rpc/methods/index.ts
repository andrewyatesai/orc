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
 */
export const RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES: RpcMethodGroupPolicies<
  typeof RPC_METHOD_GROUPS
> = {
  status: callerScopeExempt(
    'the liveness handshake every remote command starts from: version, graph state, aggregate counts — it names no host object.'
  ),
  pairing: callerScopeExempt(
    'device pairing runs before any host identity exists and touches only relay credentials.'
  ),
  worktree: callerScopeExempt(
    'every selector resolves through the caller-bounded worktree and repo catalogs.'
  ),
  agentSession: callerScopeExempt(
    'both methods name a worktree, resolved through the bounded worktree catalog.'
  ),
  terminal: callerScopeExempt(
    'panes are addressed by handle or pane key, both bounded registries, and the roster is filtered.'
  ),
  terminalAwait: callerScopeExempt('addresses a pane by handle — the bounded handle registry.'),
  terminalContext: callerScopeExempt('addresses a pane by handle — the bounded handle registry.'),
  terminalSubmit: callerScopeExempt('addresses a pane by handle — the bounded handle registry.'),
  terminalKey: callerScopeExempt('addresses a pane by handle — the bounded handle registry.'),
  orchestration: callerScopeExempt(
    'mail is bounded per named recipient/mailbox and fan-out by group membership.'
  ),
  linear: callerScopeExempt(
    'Linear is a cloud workspace, not a machine — no host object to bound.'
  ),
  linearAgentAccess: callerScopeExempt(
    'Linear is a cloud workspace, not a machine — no host object to bound.'
  ),
  browser: callerScopeGuardedBy(
    browserCallerScopeGuard,
    'the worktree whose session the command drives IS the host selector; eval/exec stay local-only.'
  )
}

export const ALL_RPC_METHODS = bindRpcMethodGroupsToCallerScope(
  RPC_METHOD_GROUPS,
  RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES
)
