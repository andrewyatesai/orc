// The pre-ready contract gate for the git-wasm shims.
//
// The rule (docs/rust-migration/ported-modules.md, "The pre-ready fallback
// contract"): a shim's not-ready value must be what the deleted TypeScript twin
// would have returned FOR THAT INPUT. The Rust core is a parity port of that
// twin, so the twin's answer is observable — it is the READY answer. That makes
// the rule mechanically checkable with no heuristic: call the shim before
// `initGitWasmForTestFromBytes`, call it again after, compare.
//
// Every row is an observed fact, so this gate cannot false-flag. What it does
// NOT prove is that a caller handles a `sentinel`; that stays a review
// obligation, named in `handledBy`. `divergence` rows are the KNOWN violations
// from the 2026-07 audit, pinned here so a fix flips a test red and gets
// re-declared as `parity` instead of drifting back.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { initGitWasmForTestFromBytes } from './git-line-stats'
import { deriveGeneratedTabTitle } from './agent-tab-title'
import { tuiAgentToAgentKind } from './agent-kind'
import { buildAgentNotificationId } from './agent-notification-id'
import { legacyBaseRefSearchResults } from './base-ref-search-result'
import { sanitizeBranchSlug } from './branch-name-from-work'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from './browser-viewport-presets'
import { getCommitMessageModelDiscoveryHostKeyForScope } from './commit-message-host-key'
import { normalizeFeatureEducationSource } from './feature-education-telemetry'
import { buildFeatureWallTourDepthSummary } from './feature-wall-tour-depth'
import { getPublishTargetDisplayName } from './git-publish-target-status'
import { assertGitPushTargetShape } from '../../../../shared/git-push-target-shape'
import { setOrcaDispatchBinding } from '../../../../shared/orca-dispatch-seam'
import { resolveGitHubPRMergeMethods } from './github-pr-merge-methods'
import { gitLabPipelineJobsToPRChecks } from './gitlab-pipeline-checks'
import { resolveHookCommandSourcePolicy } from './hook-command-source-policy'
import { normalizeHostedReviewBaseRef } from './hosted-review-refs'
import {
  hasNativeFileDragTypes,
  resolveNativeFileDropPath
} from '../../../../shared/native-file-drop-routing'
import { normalizeProxyUrl } from './network-proxy'
import { githubAvatarIcon, sanitizeRepoIcon } from './repo-icon'
import { normalizeRepoBadgeColor, resolveRepoBadgeColor } from './repo-badge-color'
import { getSetupRunnerCommandPlatformForPath } from './setup-runner-command-platform'
import {
  buildSetupScriptPromptActionTelemetry,
  buildSetupScriptPromptTelemetry
} from './setup-script-telemetry'
import { filterAvailableTaskProviders, resolveVisibleTaskProvider } from './task-providers'
import { parseTaskQuery, withQualifier } from './task-query'
import { normalizeTerminalFontWeight, resolveTerminalFontWeights } from './terminal-fonts'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from './terminal-surface-id'
import {
  getTerminalQuickCommandAction,
  normalizeTerminalQuickCommands
} from './terminal-quick-commands'
import { isValidHostTerminalTabId, isValidTerminalTabId } from './terminal-tab-id'
import { slugifyForWorkspaceName } from './workspace-name'
import type { FeatureWallTourDepthInput } from '../../../../shared/feature-wall-tour-depth'
import type {
  TerminalAgentQuickCommand,
  TerminalCommandQuickCommand
} from '../../../../shared/types'

type Contract =
  /** Pre-ready value equals the ready value — the rule, satisfied. */
  | { kind: 'parity'; why: string }
  /** Pre-ready is a declared not-ready SIGNAL the caller branches on. */
  | { kind: 'sentinel'; value: unknown; handledBy: string }
  /** Known violation: pre-ready is a value the caller reads as a real answer. */
  | { kind: 'divergence'; consequence: string }

type PreReadyCase = { name: string; call: () => unknown; contract: Contract }

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

// The done-maps are total Records; "nothing completed yet" is an absent key at
// runtime, so spell it once here rather than enumerating every id.
const NOTHING_DONE = {
  workflowDone: {} as FeatureWallTourDepthInput['workflowDone'],
  stepDone: {} as FeatureWallTourDepthInput['stepDone']
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
    name: 'git-publish-target-status.getPublishTargetDisplayName',
    call: () =>
      getPublishTargetDisplayName({ remoteName: 'upstream', branchName: 'feature/foo' }),
    contract: {
      kind: 'parity',
      why: 'the fallback rejoins remote/branch inline — the twin did nothing else, for any input'
    }
  },
  // All four branches of the one exported function, because the fallback
  // reproduces the mapping rather than a constant: a row per branch is what
  // stops it drifting from the core. Parity is mandatory here — the result is a
  // CACHE KEY into persisted settings (discoveredModelsByAgentByHost /
  // selectedModelByAgentByHost), and source-control-ai.ts reads an absent key as
  // LOCAL, so a sentinel would come back as a wrong host key instead of a signal.
  {
    name: 'commit-message-host-key.forScope(undefined)',
    call: () => getCommitMessageModelDiscoveryHostKeyForScope(undefined),
    contract: { kind: 'parity', why: "an undefined scope is 'unknown' in both states" }
  },
  {
    name: 'commit-message-host-key.forScope(null)',
    call: () => getCommitMessageModelDiscoveryHostKeyForScope(null),
    contract: { kind: 'parity', why: "no scope is the 'local' constant the twin returned" }
  },
  {
    name: 'commit-message-host-key.forScope("runtime:env-1")',
    call: () => getCommitMessageModelDiscoveryHostKeyForScope('runtime:env-1'),
    contract: { kind: 'parity', why: 'a runtime scope passes through unchanged in both states' }
  },
  {
    name: 'commit-message-host-key.forScope("conn-1")',
    call: () => getCommitMessageModelDiscoveryHostKeyForScope('conn-1'),
    contract: {
      kind: 'parity',
      why: 'the fallback re-prefixes ssh: inline — the twin did nothing else, for any connection id'
    }
  },
  {
    name: 'github-pr-merge-methods.resolveGitHubPRMergeMethods(null)',
    call: () => resolveGitHubPRMergeMethods(null),
    contract: { kind: 'parity', why: 'no settings is exactly the constant the twin returned' }
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
  {
    name: 'feature-education-telemetry.normalizeFeatureEducationSource(off-table)',
    call: () => normalizeFeatureEducationSource('not-a-source'),
    contract: { kind: 'parity', why: "an off-table source is 'unknown' in both states" }
  },
  {
    name: 'gitlab-pipeline-checks.gitLabPipelineJobsToPRChecks',
    call: () => gitLabPipelineJobsToPRChecks([]),
    contract: {
      kind: 'sentinel',
      value: null,
      handledBy:
        'ChecksPanel.fetchGitLabDetails skips the poll update, holds the spinner while pending (the ready edge refetches), and hides ChecksList once availability is terminal — an empty list reads as "No checks configured"'
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
  // All three branches of the resolver, because the fallback reproduces the
  // twin's body rather than a constant. Parity is mandatory and a sentinel is
  // impossible: the two-member union has no spare state, and the answer picks the
  // SHELL that executes the setup runner — a wrong 'windows' types
  // `cmd.exe /c "/home/…/run.sh"` at a bash prompt.
  {
    name: 'setup-runner-command-platform.getSetupRunnerCommandPlatformForPath (windows-absolute)',
    call: () =>
      getSetupRunnerCommandPlatformForPath('C:\\repo\\.git\\orca\\setup-runner.cmd', 'posix'),
    contract: {
      kind: 'parity',
      why: 'the fallback re-runs isWindowsAbsolutePathLike inline, exactly as the deleted twin did'
    }
  },
  {
    name: 'setup-runner-command-platform.getSetupRunnerCommandPlatformForPath (posix-absolute)',
    call: () =>
      getSetupRunnerCommandPlatformForPath('/remote/repo/.git/orca/setup-runner.sh', 'windows'),
    contract: {
      kind: 'parity',
      why: 'the fallback keeps the twin\'s leading-slash branch, which outranks the caller fallback'
    }
  },
  {
    name: 'setup-runner-command-platform.getSetupRunnerCommandPlatformForPath (caller fallback)',
    call: () => getSetupRunnerCommandPlatformForPath('orca/setup-runner.sh', 'windows'),
    contract: {
      kind: 'parity',
      why: 'a relative path returns the caller-supplied platform unchanged, in Rust and in the fallback'
    }
  },
  {
    // Case 3: mode/provider/buckets are all derived from the candidate, so no
    // constant is honest. A schema-VALID guess is the hazard here — the main
    // validator would accept `{mode:'configure_needed',…}` and record it as a
    // real exposure forever, so the only safe pre-ready value is "no event".
    name: 'setup-script-telemetry.buildSetupScriptPromptTelemetry',
    call: () => buildSetupScriptPromptTelemetry({ candidate: null, hasSharedHooks: true }),
    contract: {
      kind: 'sentinel',
      value: null,
      handledBy:
        'trackSetupScriptPromptExposure returns before adding the prompt key, so the exposure re-fires on a later render instead of being counted wrong'
    }
  },
  {
    name: 'setup-script-telemetry.buildSetupScriptPromptActionTelemetry',
    call: () =>
      buildSetupScriptPromptActionTelemetry({
        action: 'configure_clicked',
        candidate: null,
        hasSharedHooks: false
      }),
    contract: {
      kind: 'sentinel',
      value: null,
      handledBy:
        'trackSetupScriptPromptAction (SetupScriptPromptCard) skips the track() call; the funnel loses a step rather than gaining a mislabelled one'
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
  {
    name: 'hosted-review-refs.normalizeHostedReviewBaseRef("refs/heads/main")',
    call: () => normalizeHostedReviewBaseRef('refs/heads/main'),
    contract: {
      kind: 'divergence',
      consequence: 'the unstripped ref never equals a branch name, so base-ref comparisons miss'
    }
  },
  {
    name: 'task-query.parseTaskQuery("is:open author:me")',
    call: () => parseTaskQuery('is:open author:me'),
    contract: {
      kind: 'divergence',
      consequence: "an empty parse is indistinguishable from a query with no filters — TaskPage shows everything"
    }
  },
  {
    name: 'task-query.withQualifier',
    call: () => withQualifier('', 'state', 'open'),
    contract: {
      kind: 'divergence',
      consequence: 'the filter click silently no-ops (the query is returned unchanged)'
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
  {
    name: 'task-providers.filterAvailableTaskProviders',
    call: () =>
      filterAvailableTaskProviders(['github', 'gitlab', 'linear', 'jira'], {
        gitlabInstalled: false,
        linearConnected: false
      }),
    contract: {
      kind: 'divergence',
      consequence: 'unavailable providers stay in the UI — the whole point of the filter'
    }
  },
  {
    name: 'task-providers.resolveVisibleTaskProvider(hidden preference)',
    call: () => resolveVisibleTaskProvider('linear', ['github']),
    contract: { kind: 'divergence', consequence: 'resolves to a provider that is not visible' }
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
    name: 'branch-name-from-work.sanitizeBranchSlug',
    call: () => sanitizeBranchSlug('Fix The Bug!!'),
    contract: {
      kind: 'divergence',
      consequence: 'the "slug" keeps spaces and punctuation — not a valid git ref'
    }
  },
  {
    // Case 3: the twin strips `origin/`/`upstream/` only when a non-empty
    // remainder follows, so the answer depends on the input and no constant is
    // honest. List-shaped on purpose — a per-row null collapses to `[]`, which
    // the branch picker renders as "No matching branches".
    name: 'base-ref-search-result.legacyBaseRefSearchResults(["origin/main"])',
    call: () => legacyBaseRefSearchResults(['origin/main']),
    contract: {
      kind: 'sentinel',
      value: null,
      handledBy:
        'searchRuntimeRepoBaseRefDetails and the web preload repos.searchBaseRefDetails throw BaseRefDetailsUnavailableError, so the PR dialog shows "Branch discovery failed." and SmartWorkspaceNameField its branch-search failure line instead of an empty list'
    }
  },
  {
    name: 'agent-kind.tuiAgentToAgentKind("claude")',
    call: () => tuiAgentToAgentKind('claude'),
    contract: { kind: 'divergence', consequence: "telemetry attributes the run to 'other'" }
  },
  {
    name: 'feature-wall-tour-depth.buildFeatureWallTourDepthSummary',
    call: () =>
      buildFeatureWallTourDepthSummary({
        visitedWorkflows: new Set(['start']),
        visitedSteps: new Set(['terminal']),
        workflowDone: NOTHING_DONE.workflowDone,
        stepDone: NOTHING_DONE.stepDone,
        lastGroupId: null
      }),
    contract: {
      kind: 'divergence',
      consequence: 'all-zero counts and a MISSING furthest_step field are emitted as real telemetry'
    }
  },
  {
    name: 'workspace-name.slugifyForWorkspaceName',
    call: () => slugifyForWorkspaceName('My Thing'),
    contract: {
      kind: 'divergence',
      consequence: "'' is indistinguishable from \"no usable name\", so the create form seeds blank"
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
  {
    name: 'terminal-surface-id.toWebTerminalSurfaceTabId',
    call: () => toWebTerminalSurfaceTabId('host-tab-1::leaf-9'),
    contract: {
      kind: 'parity',
      why: 'the fallback re-encodes inline from the kept prefix constant — required, this value keys the tab store and feeds makePaneKey()'
    }
  },
  {
    name: 'terminal-surface-id.toHostSessionTabId(wrapped)',
    call: () => toHostSessionTabId('web-terminal-host-tab-1%3A%3Aleaf-9'),
    contract: {
      kind: 'parity',
      why: 'the fallback is the twin body verbatim — orphan recovery reaps surfaces whose host key does not match, so no sentinel is survivable'
    }
  },
  {
    name: 'terminal-surface-id.toHostSessionTabId(non-prefixed)',
    call: () => toHostSessionTabId('host-tab::leaf'),
    contract: { kind: 'parity', why: 'a non-prefixed id passes through unchanged in both states' }
  },
  {
    name: 'terminal-surface-id.isWebTerminalSurfaceTabId',
    call: () => isWebTerminalSurfaceTabId('web-terminal-abc'),
    contract: {
      kind: 'parity',
      why: 'the fallback is the prefix test itself over the kept constant, so the predicate cannot answer false pre-ready'
    }
  },
  {
    // NOT a pre-ready defect: pre-ready is the twin's answer. This pins the
    // READY side — a port divergence already recorded as `allowDivergence` in
    // tools/parity/vectors/terminal-surface-id.json. On a malformed escape the
    // TS catch returned the WHOLE tabId; orca_core::terminal_surface_id returns
    // the decoded slice. Unreachable for ids minted by
    // toWebTerminalSurfaceTabId (encodeURIComponent output always decodes).
    name: 'terminal-surface-id.toHostSessionTabId("web-terminal-%zz")',
    call: () => toHostSessionTabId('web-terminal-%zz'),
    contract: {
      kind: 'divergence',
      consequence:
        'the Rust core drops the prefix ("%zz") where the twin returned "web-terminal-%zz"; both are non-matching host ids, so a malformed mirrored id is reaped by orphan recovery either way'
    }
  },
  {
    name: 'terminal-tab-id.isValidTerminalTabId("plain-tab")',
    call: () => isValidTerminalTabId('plain-tab'),
    contract: {
      kind: 'parity',
      why: 'the fallback is the twin body over the kept delimiter constant — no sentinel exists for a boolean consumed inside `&&`/`.filter`, and a wrong answer re-keys a live tab'
    }
  },
  {
    name: 'terminal-tab-id.isValidTerminalTabId("host-tab::leaf")',
    call: () => isValidTerminalTabId('host-tab::leaf'),
    contract: {
      kind: 'parity',
      why: 'the rejecting direction too: tabs-hydration must drop a colon-bearing persisted id pre-ready exactly as ready'
    }
  },
  {
    name: 'terminal-tab-id.isValidHostTerminalTabId("web-terminal-abc")',
    call: () => isValidHostTerminalTabId('web-terminal-abc'),
    contract: {
      kind: 'parity',
      why: 'the fallback composes the same prefix test — createTab must not adopt a renderer-local surface id as a host tab hint in either state'
    }
  },
  {
    name: 'terminal-tab-id.isValidHostTerminalTabId("plain-tab")',
    call: () => isValidHostTerminalTabId('plain-tab'),
    contract: {
      kind: 'parity',
      why: 'the accepting direction: a pre-ready false would make createTab mint a fresh UUID and orphan the host PTY binding'
    }
  },
  {
    name: 'git-push-target-shape.assertGitPushTargetShape(valid)',
    call: () => pushTargetOutcome({ remoteName: 'origin', branchName: 'feature/fix' }),
    contract: {
      kind: 'parity',
      why: 'an `asserts` fn has only throw/return, both real answers — the fallback is the twin body over the kept rule constants, so a valid target is never rejected while the seam is unbound'
    }
  },
  {
    name: 'git-push-target-shape.assertGitPushTargetShape(traversal remote)',
    call: () => pushTargetOutcome({ remoteName: 'foo/../bar', branchName: 'feature/fix' }),
    contract: {
      kind: 'parity',
      why: 'the rejecting direction, message included: this is the anti-traversal gate on a value replayed into `git push`, so pre-ready must not fail open'
    }
  },
  {
    name: 'git-push-target-shape.assertGitPushTargetShape(lone surrogate in branch)',
    call: () => pushTargetOutcome({ remoteName: 'origin', branchName: 'feat-\ud800' }),
    contract: {
      kind: 'parity',
      why: 'the codec refuses to encode it in BOTH states, so both take the fallback — the twin accepted it (check-ref-format is the next gate), and the reverted first attempt was exactly this accept turning into a reject naming the wrong field'
    }
  },
  // Parity is mandatory for both, and a sentinel is impossible for either. The
  // real consumer is src/preload/index.ts, which can bind NEITHER binding, so
  // its seam stays unbound for the whole session — the fallback is the behaviour
  // of every OS file drop. hasNativeFileDragTypes is a bare boolean consumed
  // inside `if (!…) return`, and resolveNativeFileDropPath's `null` is a real
  // answer ("no surface claimed it" → an editor drop).
  {
    name: 'native-file-drop-routing.hasNativeFileDragTypes(["Files"])',
    call: () => hasNativeFileDragTypes(['Files']),
    contract: {
      kind: 'parity',
      why: 'the fallback is the twin body over the kept internal-drag-type constant — a pre-ready false would make the preload dragover handler ignore every native drag'
    }
  },
  {
    name: 'native-file-drop-routing.hasNativeFileDragTypes(internal move)',
    call: () => hasNativeFileDragTypes(['Files', 'text/x-orca-file-path']),
    contract: {
      kind: 'parity',
      why: 'the rejecting direction: a pre-ready true would hijack Orca\'s own file-explorer→terminal drags away from their React handlers'
    }
  },
  {
    name: 'native-file-drop-routing.resolveNativeFileDropPath(terminal + leaf)',
    call: () =>
      resolveNativeFileDropPath([
        { terminalPaneLeafId: 'leaf-9' },
        { nativeFileDropTarget: 'terminal', terminalTabId: 'tab-1' }
      ]),
    contract: {
      kind: 'parity',
      why: 'paneLeafId is UNPORTED (orca_core has no such entry field) so the shim composes it on both paths — without it a drop on one split pastes into the active pane instead'
    }
  },
  {
    name: 'native-file-drop-routing.resolveNativeFileDropPath(nearest explorer dir)',
    call: () =>
      resolveNativeFileDropPath([
        { nativeFileDropDir: '/repo/src' },
        { nativeFileDropTarget: 'file-explorer', nativeFileDropDir: '/repo' }
      ]),
    contract: {
      kind: 'parity',
      why: 'the destination dir is the write target for the dropped files, so an innermost-vs-outermost difference would copy them into the wrong folder'
    }
  },
  {
    name: 'native-file-drop-routing.resolveNativeFileDropPath(explorer, no dir)',
    call: () => resolveNativeFileDropPath([{ nativeFileDropTarget: 'file-explorer' }]),
    contract: {
      kind: 'parity',
      why: 'the fail-closed branch: `rejected` drops the gesture, where a pre-ready null would fall through to the editor default and open the files instead'
    }
  },
  {
    name: 'native-file-drop-routing.resolveNativeFileDropPath(unclaimed)',
    call: () => resolveNativeFileDropPath([{ nativeFileDropDir: '/repo' }]),
    contract: {
      kind: 'parity',
      why: 'null here is the twin\'s real answer for this input, not a signal — createNativeFileDropPayload turns it into the editor drop'
    }
  }
]

// An `asserts` shim answers by throwing, so shape it into a comparable value.
function pushTargetOutcome(target: unknown): { ok: boolean; error?: string } {
  try {
    assertGitPushTargetShape(target)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Serialized so a Set/undefined compares stably; the shims are JSON-boundary
// functions, so a JSON view loses nothing they can return.
function snapshot(call: () => unknown): string {
  return JSON.stringify(call(), (_key, value) => (value instanceof Set ? [...value] : value)) ?? 'undefined'
}

// Why: config/vitest-orca-dispatch-seam.ts binds the shared seam for every test
// file at import time, so a shim that reaches Rust through the seam (rather than
// through this directory's isGitWasmReady/dispatchToWasmCore) would be READY
// during the pre-ready pass and its row would pass vacuously. Unbind first;
// beforeAll's initGitWasmForTestFromBytes → markReady rebinds it.
setOrcaDispatchBinding(null)

const PRE_READY = CASES.map((testCase) => snapshot(testCase.call))

beforeAll(() => {
  initGitWasmForTestFromBytes(readFileSync(new URL('./orca_git_wasm_bg.wasm', import.meta.url)))
})

describe('git-wasm shim pre-ready contract', () => {
  CASES.forEach((testCase, index) => {
    const preReady = PRE_READY[index]!
    const { contract } = testCase

    if (contract.kind === 'parity') {
      it(`${testCase.name} — pre-ready matches ready (${contract.why})`, () => {
        expect(preReady).toBe(snapshot(testCase.call))
      })
      return
    }

    if (contract.kind === 'sentinel') {
      it(`${testCase.name} — signals not-ready (${contract.handledBy})`, () => {
        expect(preReady).toBe(JSON.stringify(contract.value) ?? 'undefined')
        expect(preReady).not.toBe(snapshot(testCase.call))
      })
      return
    }

    it(`${testCase.name} — KNOWN VIOLATION: ${contract.consequence}`, () => {
      // Fix it by making the pre-ready value the ready value, or by turning it
      // into a `sentinel` the caller branches on — then re-declare this row.
      expect(preReady).not.toBe(snapshot(testCase.call))
    })
  })
})
