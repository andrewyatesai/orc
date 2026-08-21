// Pre-ready contract rows (rule + machinery:
// ./shim-pre-ready-contract-harness.ts) for settings and presentation shims:
// terminal fonts and quick commands, tab-title ladders, agent tab/notification
// titles, synthetic agent titles, TUI-agent selection, repo icons and badges,
// browser viewport presets, proxy URL normalization, MCP config inspection,
// and hook command source policy.
import { deriveGeneratedTabTitle } from './agent-tab-title'
import { buildAgentNotificationId } from './agent-notification-id'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from './browser-viewport-presets'
import { resolveHookCommandSourcePolicy } from './hook-command-source-policy'
import { inspectMcpConfigContent } from './mcp-config-content-inspection'
import { MCP_CONFIG_CANDIDATES } from '../../../../shared/mcp-config'
import { normalizeProxyUrl } from './network-proxy'
import { githubAvatarIcon, sanitizeRepoIcon } from './repo-icon'
import { normalizeRepoBadgeColor, resolveRepoBadgeColor } from './repo-badge-color'
import {
  getSyntheticAgentTerminalTitle,
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook
} from '../../../../shared/synthetic-agent-title-resolution'
import {
  resolveTerminalTabTitle,
  resolveUnifiedTabLabel
} from '../../../../shared/tab-title-ladder'
import { normalizeTerminalFontWeight, resolveTerminalFontWeights } from './terminal-fonts'
import {
  getTerminalQuickCommandAction,
  normalizeTerminalQuickCommands
} from './terminal-quick-commands'
import {
  collapseDefaultTuiAgentToBuiltin,
  filterEnabledTuiAgents,
  isTuiAgentEnabled,
  normalizeDisabledTuiAgents,
  pickTuiAgent
} from '../../../../shared/tui-agent-selection-resolution'
import type {
  TerminalAgentQuickCommand,
  TerminalCommandQuickCommand
} from '../../../../shared/types'
import { runShimPreReadyContractSuite } from './shim-pre-ready-contract-harness'
import type { PreReadyCase } from './shim-pre-ready-contract-harness'

const TERMINAL_COMMAND: TerminalCommandQuickCommand = {
  id: 'qc-1',
  label: 'Status',
  scope: { type: 'global' },
  action: 'terminal-command',
  command: 'git status',
  appendEnter: true
}

const AGENT_COMMAND: TerminalAgentQuickCommand = {
  id: 'qc-2',
  label: 'Ask',
  scope: { type: 'repo', repoId: 'repo-1' },
  action: 'agent-prompt',
  agent: 'claude',
  prompt: 'review this'
}

const CASES: PreReadyCase[] = [
  {
    name: 'repo-icon.githubAvatarIcon',
    call: () => githubAvatarIcon({ owner: 'octo', repo: 'kit' }),
    contract: {
      kind: 'parity',
      why: 'the fallback rebuilds the same avatar icon inline, so the caller cannot tell'
    }
  },
  {
    name: 'terminal-fonts.resolveTerminalFontWeights(undefined)',
    call: () => resolveTerminalFontWeights(undefined),
    contract: { kind: 'parity', why: 'unset weight resolves to the same documented default pair' }
  },
  {
    name: 'hook-command-source-policy.resolveHookCommandSourcePolicy(undefined)',
    call: () => resolveHookCommandSourcePolicy(undefined, { hasLocalScript: false }),
    contract: { kind: 'parity', why: 'unconfigured policy is the shared-only constant' }
  },
  // The one shim whose two input classes get different contracts: an absent file
  // is a constant the twin returned unconditionally, real content is a parse plus
  // four DoS bounds computed from the text.
  {
    name: 'mcp-config-content-inspection.inspectMcpConfigContent(candidate, null)',
    call: () => inspectMcpConfigContent(MCP_CONFIG_CANDIDATES[0], null),
    contract: {
      kind: 'parity',
      why: 'the twin returned the missing-file constant for every candidate, reading nothing else'
    }
  },
  {
    name: 'mcp-config-content-inspection.inspectMcpConfigContent(candidate, content)',
    call: () => inspectMcpConfigContent(MCP_CONFIG_CANDIDATES[0], '{"mcpServers":{}}'),
    contract: {
      kind: 'sentinel',
      value: null,
      handledBy:
        'loadMcpConfigInspections throws McpConfigInspectionUnavailableError instead of inventing a row (a guessed "valid, no servers" would also call a 300 KiB config valid, which is what the size bound refuses); McpConfigSection shows the preparing/unavailable banner and re-runs the load on the availability edge it subscribes to'
    }
  },
  {
    name: 'agent-notification-id.buildAgentNotificationId',
    call: () =>
      buildAgentNotificationId({
        worktreeId: 'repo::/userhome/me/orca/workspaces/feature',
        paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
        stateStartedAt: 1780000000123
      }),
    contract: {
      kind: 'sentinel',
      value: null,
      handledBy:
        "use-notification-dispatch omits notificationId from the dispatch payload (main shows the notification, unregistered for dismiss) and ui.ts acknowledgeAgents' `if (id)` adds nothing to the dismiss set"
    }
  },
  {
    name: 'agent-tab-title.deriveGeneratedTabTitle',
    call: () => deriveGeneratedTabTitle('add a login page to the settings screen'),
    contract: {
      kind: 'sentinel',
      value: null,
      handledBy: 'the tab keeps its default title; the next store update applies the real one'
    }
  },
  {
    // Case 3: resolve() answers from the input and returns
    // DEFAULT_REPO_BADGE_COLOR only for an INVALID one, so neither the constant
    // (the reverted value) nor null is honest — `undefined` is, because the ready
    // core never returns it.
    name: 'repo-badge-color.resolveRepoBadgeColor("#ff0000")',
    call: () => resolveRepoBadgeColor('#ff0000'),
    contract: {
      kind: 'sentinel',
      value: undefined,
      handledBy:
        'ColorPicker disables its trigger and returns from updateColor/updateDraft/onBlur, so no wheel drag can persist a placeholder; the read-only badge painters fall back to neutral'
    }
  },
  {
    name: 'repo-badge-color.normalizeRepoBadgeColor(invalid)',
    call: () => normalizeRepoBadgeColor('not-a-colour'),
    contract: {
      kind: 'sentinel',
      value: undefined,
      handledBy:
        'ColorPicker gates hasInvalidDraft on the sentinel (no false "Invalid hex color"); store/slices/repos.ts sanitizeRepoUpdate drops badgeColor rather than storing an unvalidated one'
    }
  },
  {
    name: 'terminal-fonts.normalizeTerminalFontWeight(300)',
    call: () => normalizeTerminalFontWeight(300),
    contract: {
      kind: 'divergence',
      consequence:
        'the settings slider commits the normalized value, so any drag persists 500 and discards the user weight'
    }
  },
  {
    name: 'terminal-quick-commands.normalizeTerminalQuickCommands(list)',
    call: () => normalizeTerminalQuickCommands([TERMINAL_COMMAND]),
    contract: {
      kind: 'divergence',
      consequence:
        'the settings slice persists this, so one unrelated settings write empties the saved quick commands'
    }
  },
  {
    name: 'terminal-quick-commands.getTerminalQuickCommandAction(agent)',
    call: () => getTerminalQuickCommandAction(AGENT_COMMAND),
    contract: {
      kind: 'divergence',
      consequence: 'an agent-prompt command is dispatched down the terminal-command branch'
    }
  },
  // Both rows are mandatory parity, not tidy: the resolved string IS the tab's
  // visible identity. TabBar.tsx hands it to resolveCommittedTerminalTitleAgentType,
  // so a wrong answer flips the tab's agent kind, and sync-runtime-graph.ts
  // publishes it to paired mobile clients. The return type is a total string
  // whose `''` already means "nothing usable" — the twin's own default fallback
  // — so no sentinel has anywhere to live. The vault case is spelled out because
  // a port that dropped that one rung is what this row exists to catch.
  {
    name: 'tab-title-ladder.resolveTerminalTabTitle(AI Vault title over a spinner OSC title)',
    call: () =>
      resolveTerminalTabTitle(
        {
          customTitle: null,
          aiVaultTitle: { title: 'Repair provider-native tab titles' },
          generatedTitle: 'Orca generated',
          title: '⠋ albacore'
        },
        true
      ),
    contract: {
      kind: 'parity',
      why: 'the fallback re-runs the twin ladder inline, vault rung included, over the kept parts types'
    }
  },
  {
    name: 'tab-title-ladder.resolveUnifiedTabLabel(native OpenCode label)',
    call: () =>
      resolveUnifiedTabLabel(
        {
          customLabel: null,
          generatedLabel: 'Fix flaky tests',
          label: 'OC | Native Stable Session'
        },
        true
      ),
    contract: {
      kind: 'parity',
      why: 'same ladder over the label fields, calling the TypeScript isMeaningfulOpenCodeTerminalTitle the twin called'
    }
  },
  {
    name: 'network-proxy.normalizeProxyUrl(invalid)',
    call: () => normalizeProxyUrl('not a url'),
    contract: {
      kind: 'divergence',
      consequence: 'ok:true persists an unvalidated proxy URL and hides the validation message'
    }
  },
  // Parity is mandatory for both browser-viewport rows: the result is fed
  // straight to window.api.browser.setViewportOverride, so a null pre-ready row
  // would send `override: null` and un-emulate a viewport the menu shows
  // checked — on every dom-ready, for the whole session, if the core failed.
  {
    name: 'browser-viewport-presets.getBrowserViewportPreset("tablet")',
    call: () => getBrowserViewportPreset('tablet'),
    contract: {
      kind: 'parity',
      why: 'the fallback finds the row in the kept BROWSER_VIEWPORT_PRESETS table — the twin did nothing else, for any id'
    }
  },
  {
    name: 'browser-viewport-presets.getBrowserViewportPreset(null)',
    call: () => getBrowserViewportPreset(null),
    contract: {
      kind: 'parity',
      why: 'no preset selected is null in both states, as the twin returned'
    }
  },
  {
    name: 'browser-viewport-presets.browserViewportPresetToOverride(mobile-s)',
    call: () =>
      browserViewportPresetToOverride({
        id: 'mobile-s',
        label: 'Mobile S — 320 × 568',
        width: 320,
        height: 568,
        deviceScaleFactor: 2,
        mobile: true
      }),
    contract: {
      kind: 'parity',
      why: 'the fallback copies the four emulation fields inline — the twin was that projection, for any row'
    }
  },
  {
    name: 'repo-icon.sanitizeRepoIcon(javascript: src)',
    call: () => sanitizeRepoIcon({ type: 'image', src: 'javascript:alert(1)', source: 'custom' }),
    contract: {
      kind: 'divergence',
      consequence: 'the unsafe icon is passed through to the reducer instead of being rejected'
    }
  },
  // Synthetic agent titles, a row per exported function. Parity is mandatory and
  // no sentinel exists: main gates driveSyntheticTitleFromHook on the predicate
  // and then writes the profile's labels into the PTY as an OSC 0 sequence, and
  // agent-title-owner rewrites AgentStatusEntry.terminalTitle in mirrored remote
  // entries — a pre-ready answer that is not the ready answer sticks as a wrong
  // (or missing) terminal title for the whole session.
  {
    name: 'synthetic-agent-title-resolution.getSyntheticAgentTitleProfile(codex)',
    call: () => getSyntheticAgentTitleProfile('codex'),
    contract: {
      kind: 'parity',
      why: 'the fallback is an own-key read of the kept profile TABLE, so the labels main writes into the PTY are identical before and after the core lands'
    }
  },
  {
    name: 'synthetic-agent-title-resolution.getSyntheticAgentTitleProfile(unknown agent)',
    call: () => getSyntheticAgentTitleProfile('claude'),
    contract: {
      kind: 'parity',
      why: "null is the twin's real answer for an agent with no profile, not a not-ready signal — main already branches on it and drives no title"
    }
  },
  {
    // Pins the correction, not just the value: `AgentType` is `string & {}`, and
    // the twin's raw `TABLE[agentType]` returned Object.prototype.toString here,
    // which main then wrote into the PTY as `\x1b]0;⠋ undefined\x07`. Both paths
    // answer as orca_core does; a raw index lookup in the fallback turns it red.
    name: 'synthetic-agent-title-resolution.getSyntheticAgentTitleProfile(inherited key)',
    call: () => getSyntheticAgentTitleProfile('toString'),
    contract: {
      kind: 'parity',
      why: 'an inherited Object.prototype member is not a profile on either path'
    }
  },
  {
    name: 'synthetic-agent-title-resolution.getSyntheticAgentTerminalTitle(codex, done)',
    call: () => getSyntheticAgentTerminalTitle('codex', 'done'),
    contract: {
      kind: 'parity',
      why: 'this string IS the OSC 0 title; a pre-ready null would skip the idle frame native OSC already misses'
    }
  },
  {
    name: 'synthetic-agent-title-resolution.getSyntheticAgentTerminalTitle(opencode, waiting)',
    call: () => getSyntheticAgentTerminalTitle('opencode', 'waiting'),
    contract: {
      kind: 'parity',
      why: "null is the twin's real answer — OpenCode owns its semantic session title and a synthesized one would overwrite it"
    }
  },
  {
    name: 'synthetic-agent-title-resolution.shouldDriveSyntheticAgentTitleFromHook(codex, working)',
    call: () => shouldDriveSyntheticAgentTitleFromHook('codex', 'working'),
    contract: {
      kind: 'parity',
      why: "a total predicate with no spare state: false keeps Codex's native spinner, and a pre-ready true would overwrite it on every hook event"
    }
  },
  {
    name: 'synthetic-agent-title-resolution.shouldDriveSyntheticAgentTitleFromHook(devin, done)',
    call: () => shouldDriveSyntheticAgentTitleFromHook('devin', 'done'),
    contract: {
      kind: 'parity',
      why: 'the write-back gate at src/main/index.ts:1436 — a pre-ready false is a session with no synthetic titles at all'
    }
  },
  // TUI-agent selection: parity is forced on all five, because the answers pick
  // the launch command AND get written back — use-onboarding-flow.ts:197 saves
  // the collapsed default as `defaultTuiAgent`, and normalizeDisabledTuiAgents
  // IS the settings sanitizer at persistence.ts:5893 / slices/settings.ts:90.
  {
    name: 'tui-agent-selection.collapseDefaultTuiAgentToBuiltin(custom profile)',
    call: () =>
      collapseDefaultTuiAgentToBuiltin({ kind: 'custom', id: 'p1' }, [
        { id: 'p1', label: 'Claude (zai)', baseAgent: 'claude', command: 'claude' }
      ]),
    contract: {
      kind: 'parity',
      why: 'the onboarding hydration persists this as the user default agent, so any other pre-ready value is saved over their choice'
    }
  },
  {
    name: 'tui-agent-selection.collapseDefaultTuiAgentToBuiltin(never set)',
    call: () => collapseDefaultTuiAgentToBuiltin(undefined, []),
    contract: {
      kind: 'parity',
      why: 'undefined (never written) must stay distinct from null (explicit auto) in both states — callers spread the answer into props and IPC payloads'
    }
  },
  {
    name: 'tui-agent-selection.pickTuiAgent(stale preference)',
    call: () => pickTuiAgent('gemini', ['cursor', 'codex'], ['claude']),
    contract: {
      kind: 'parity',
      why: 'this is the agent that launches; null already means "nothing qualifies", so it cannot double as a not-ready signal'
    }
  },
  {
    name: 'tui-agent-selection.normalizeDisabledTuiAgents(mixed list)',
    call: () => normalizeDisabledTuiAgents(['codex', 'unknown', 'codex', null, 'claude']),
    contract: {
      kind: 'parity',
      why: 'the sanitizer output is what lands in the settings file, so a pre-ready [] re-enables every agent the user turned off'
    }
  },
  {
    name: 'tui-agent-selection.isTuiAgentEnabled(disabled agent)',
    call: () => isTuiAgentEnabled('codex', ['codex']),
    contract: {
      kind: 'parity',
      why: 'a total predicate consumed inside if/&&, so a pre-ready true offers a disabled agent as a launch target'
    }
  },
  {
    name: 'tui-agent-selection.filterEnabledTuiAgents(one disabled)',
    call: () => filterEnabledTuiAgents(['claude', 'codex', 'grok'], ['codex']),
    contract: {
      kind: 'parity',
      why: 'the picker list itself — [] already means "all disabled", so it cannot double as a signal'
    }
  }
]

runShimPreReadyContractSuite(CASES)
