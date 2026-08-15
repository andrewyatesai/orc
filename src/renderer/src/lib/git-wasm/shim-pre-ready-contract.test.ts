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
import { normalizeFeatureEducationSource } from './feature-education-telemetry'
import { buildFeatureWallTourDepthSummary } from './feature-wall-tour-depth'
import { getPublishTargetDisplayName } from './git-publish-target-status'
import { resolveGitHubPRMergeMethods } from './github-pr-merge-methods'
import { gitLabPipelineJobsToPRChecks } from './gitlab-pipeline-checks'
import { resolveHookCommandSourcePolicy } from './hook-command-source-policy'
import { normalizeHostedReviewBaseRef } from './hosted-review-refs'
import { normalizeProxyUrl } from './network-proxy'
import { githubAvatarIcon, sanitizeRepoIcon } from './repo-icon'
import { normalizeRepoBadgeColor, resolveRepoBadgeColor } from './repo-badge-color'
import {
  buildSetupScriptPromptActionTelemetry,
  buildSetupScriptPromptTelemetry
} from './setup-script-telemetry'
import { filterAvailableTaskProviders, resolveVisibleTaskProvider } from './task-providers'
import { parseTaskQuery, withQualifier } from './task-query'
import { normalizeTerminalFontWeight, resolveTerminalFontWeights } from './terminal-fonts'
import {
  getTerminalQuickCommandAction,
  normalizeTerminalQuickCommands
} from './terminal-quick-commands'
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
  }
]

// Serialized so a Set/undefined compares stably; the shims are JSON-boundary
// functions, so a JSON view loses nothing they can return.
function snapshot(call: () => unknown): string {
  return JSON.stringify(call(), (_key, value) => (value instanceof Set ? [...value] : value)) ?? 'undefined'
}

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
