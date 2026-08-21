// Pre-ready contract rows (rule + machinery:
// ./shim-pre-ready-contract-harness.ts) for feature education and telemetry
// shims: education sources, feature tips and interaction state, contextual
// tours, feature-wall tour depth, setup-script and nested-repo telemetry, and
// agent-kind attribution.
import { tuiAgentToAgentKind } from './agent-kind'
import {
  isContextualTourId,
  normalizeContextualTourIds
} from '../../../../shared/contextual-tour-id-normalization'
import { normalizeFeatureEducationSource } from './feature-education-telemetry'
import {
  hasFeatureInteraction,
  isFeatureInteractionId,
  normalizeFeatureInteractions,
  normalizeFeatureInteractionTelemetryBuckets
} from '../../../../shared/feature-interaction-state'
import {
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips,
  isFeatureTipId,
  normalizeFeatureTipIds
} from '../../../../shared/feature-tip-selection'
import { buildFeatureWallTourDepthSummary } from './feature-wall-tour-depth'
import {
  bucketNestedRepoTelemetryCount,
  buildNestedRepoImportActionTelemetry,
  buildNestedRepoImportResultTelemetry,
  buildNestedRepoScanTelemetry,
  capNestedRepoTelemetryCount,
  shouldEmitNestedRepoImportSubmitTelemetry
} from '../../../../shared/nested-repo-telemetry-payloads'
import {
  buildSetupScriptPromptActionTelemetry,
  buildSetupScriptPromptTelemetry
} from './setup-script-telemetry'
import type { FeatureTipId } from '../../../../shared/feature-tips'
import type { FeatureWallTourDepthInput } from '../../../../shared/feature-wall-tour-depth'
import { runShimPreReadyContractSuite } from './shim-pre-ready-contract-harness'
import type { PreReadyCase } from './shim-pre-ready-contract-harness'

// A nested-repo telemetry attempt id: main's schema demands a real UUID.
const NRT_ID = '2fbac1e3-5094-45b4-80a6-90281e6e9e09'

// The done-maps are total Records; "nothing completed yet" is an absent key at
// runtime, so spell it once here rather than enumerating every id.
const NOTHING_DONE = {
  workflowDone: {} as FeatureWallTourDepthInput['workflowDone'],
  stepDone: {} as FeatureWallTourDepthInput['stepDone']
}

const CASES: PreReadyCase[] = [
  {
    name: 'feature-education-telemetry.normalizeFeatureEducationSource(off-table)',
    call: () => normalizeFeatureEducationSource('not-a-source'),
    contract: { kind: 'parity', why: "an off-table source is 'unknown' in both states" }
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
  // The contextual-tour id functions decide `ui.contextualToursSeenIds`, which
  // is PERSISTED: a pre-ready `[]` hydrates an empty seen list and the next
  // updateUI writes it back, replaying every tour the user already dismissed.
  // No sentinel exists — `[]` and `false` are already both functions' real
  // answers — so parity is forced, and the web preload never binds at all.
  {
    name: 'contextual-tour-id-normalization.normalizeContextualTourIds(persisted seen list)',
    call: () =>
      normalizeContextualTourIds(['tasks', 'unknown', 'browser', 'tasks', null, 'automations']),
    contract: {
      kind: 'parity',
      why: 'the fallback re-runs the twin over the kept CONTEXTUAL_TOUR_IDS table, so the persisted list survives a core that never loads'
    }
  },
  {
    name: 'contextual-tour-id-normalization.isContextualTourId(floating-workspace)',
    call: () => isContextualTourId('floating-workspace'),
    contract: {
      kind: 'parity',
      why: 'the id the core\'s ids const omitted until this cutover — both states must accept every catalog tour, or its "seen" row is dropped on every merge'
    }
  },
  // Nested-repo telemetry, a row per exported function. The three scalar answers
  // MUST be parity: the bucketer is re-derived by main's telemetry superRefine (a
  // signal fails every event's own bucket check) and the submit predicate GATES
  // THE IMPORT, not just the event — both call sites `return` on false. The two
  // builders are sentinels, the setup-script-telemetry shape: a schema-valid guess
  // would be recorded as a real funnel step forever, and nothing retries, so the
  // step is dropped once rather than re-counted when the core lands.
  {
    name: 'nested-repo-telemetry.capNestedRepoTelemetryCount(2.9)',
    call: () => capNestedRepoTelemetryCount(2.9),
    contract: { kind: 'parity', why: 'the twin floor/clamp over the kept count cap' }
  },
  {
    name: 'nested-repo-telemetry.bucketNestedRepoTelemetryCount(7)',
    call: () => bucketNestedRepoTelemetryCount(7),
    contract: {
      kind: 'parity',
      why: 'fed to a VALIDATOR — main drops the event when bucket(count) !== bucket, so only the twin ladder is honest'
    }
  },
  {
    name: 'nested-repo-telemetry.shouldEmitNestedRepoImportSubmitTelemetry(ready)',
    call: () => shouldEmitNestedRepoImportSubmitTelemetry({ attemptId: NRT_ID, selectedCount: 2 }),
    contract: {
      kind: 'parity',
      why: 'a pre-ready false is a dead Import button for the session — both call sites return on it'
    }
  },
  {
    name: 'nested-repo-telemetry.buildNestedRepoScanTelemetry',
    call: () =>
      buildNestedRepoScanTelemetry({
        attemptId: NRT_ID,
        surface: 'sidebar',
        runtimeKind: 'local',
        scan: null
      }),
    contract: {
      kind: 'sentinel',
      value: null,
      handledBy:
        'the four scan sites (useAddRepoLocalFolderFlow / useAddRepoServerPathFlow / use-add-repo-remote-nested-scan / use-onboarding-flow) skip track("add_repo_nested_scan_result") — one funnel step lost, never a wrong one recorded'
    }
  },
  {
    name: 'nested-repo-telemetry.buildNestedRepoImportActionTelemetry',
    call: () =>
      buildNestedRepoImportActionTelemetry({
        attemptId: NRT_ID,
        surface: 'sidebar',
        runtimeKind: 'local',
        action: 'import_group',
        foundCount: 3,
        selectedCount: 2
      }),
    contract: {
      kind: 'sentinel',
      value: null,
      handledBy:
        'useAddRepoNestedImportFlow / use-onboarding-flow skip track("add_repo_nested_import_action") and CONTINUE the import — the event is optional, the import is not'
    }
  },
  {
    // Unported at the dispatch surface (orca-dispatch has no arm), so it stays
    // TS — but it composes this module's cap/bucket, so the row pins that the one
    // bucket ladder answers identically in both states.
    name: 'nested-repo-telemetry.buildNestedRepoImportResultTelemetry',
    call: () =>
      buildNestedRepoImportResultTelemetry({
        attemptId: NRT_ID,
        surface: 'onboarding',
        runtimeKind: 'runtime',
        mode: 'group',
        foundCount: 4,
        selectedCount: 4,
        result: { importedCount: 2, alreadyKnownCount: 1, failedCount: 1, projects: [] }
      }),
    contract: { kind: 'parity', why: 'both states run one TS body over Rust-backed cap/bucket' }
  },
  // Feature-interaction state: parity is forced, because the answer is PERSISTED
  // as the interaction state itself — both mergeFeatureInteractionState sites
  // (store/slices/ui.ts, web/web-preload-api.ts) normalize each side and write
  // the merged map back, so a pre-ready `{}` erases the user's recorded history,
  // replays every contextual tour and re-emits every usage bucket. A row per
  // exported function, plus the empty map that must be a real answer and not a
  // signal.
  {
    name: 'feature-interaction-state.normalizeFeatureInteractions(records)',
    call: () =>
      normalizeFeatureInteractions({
        tasks: { firstInteractedAt: 100 },
        browser: { firstInteractedAt: Number.NaN },
        unknown: { firstInteractedAt: 1 }
      }),
    contract: {
      kind: 'parity',
      why: 'the fallback re-runs the twin loop over the kept catalog — the result is written straight back to the persisted record'
    }
  },
  {
    name: 'feature-interaction-state.normalizeFeatureInteractions(non-object blob)',
    call: () => normalizeFeatureInteractions('nope'),
    contract: {
      kind: 'parity',
      why: "an empty map is the twin's real answer for a fresh/corrupt profile, not a not-ready signal"
    }
  },
  {
    name: 'feature-interaction-state.normalizeFeatureInteractionTelemetryBuckets',
    call: () =>
      normalizeFeatureInteractionTelemetryBuckets({ tasks: 'count_1', browser: 'count_4' }),
    contract: {
      kind: 'parity',
      why: 'this map is the once-only marker gating feature_interaction_usage_bucket_reached — a wrong {} re-counts the fleet'
    }
  },
  {
    name: 'feature-interaction-state.hasFeatureInteraction(recorded)',
    call: () =>
      hasFeatureInteraction({ tasks: { firstInteractedAt: 100, interactionCount: 1 } }, 'tasks'),
    contract: {
      kind: 'parity',
      why: 'a total predicate stored into activeContextualTourWasFeaturePreviouslyInteracted — false replays a tour the user finished'
    }
  },
  {
    name: 'feature-interaction-state.hasFeatureInteraction(not recorded)',
    call: () => hasFeatureInteraction({}, 'browser'),
    contract: {
      kind: 'parity',
      why: 'the rejecting direction: a pre-ready true hides the tour from a user who never used the feature'
    }
  },
  {
    name: 'feature-interaction-state.isFeatureInteractionId(catalog id)',
    call: () => isFeatureInteractionId('tasks'),
    contract: {
      kind: 'parity',
      why: "a zod z.custom refinement and main's IPC gate — a non-boolean reads truthy and admits an arbitrary id"
    }
  },
  {
    name: 'feature-interaction-state.isFeatureInteractionId(off-catalog)',
    call: () => isFeatureInteractionId('nope'),
    contract: {
      kind: 'parity',
      why: 'the rejecting direction: a pre-ready true lets an unknown id into the persisted record'
    }
  },
  // Feature tips: parity ×4, forced. Every answer is total (a boolean, and
  // three lists whose EMPTY value is the twin's real "not an array" / "nothing
  // completed" / "nothing left to show"), and all of them are PERSISTED and
  // never re-derived — the seen list is written back through window.api.ui.set,
  // and use-onboarding-and-feature-tips.ts marks the FIRST ordered tip seen the
  // moment it is shown, so a pre-ready list that is empty, over-long or merely
  // misordered suppresses the wrong tip for good.
  {
    name: 'feature-tip-selection.getOrderedUnseenFeatureTips(nothing seen)',
    call: () => getOrderedUnseenFeatureTips({ seenTipIds: new Set() }),
    contract: {
      kind: 'parity',
      why: 'element 0 is marked seen on show and never un-marked, so a misordered pre-ready list burns the wrong tip forever'
    }
  },
  {
    name: 'feature-tip-selection.getOrderedUnseenFeatureTips(cli installed, cmd-j seen)',
    call: () =>
      getOrderedUnseenFeatureTips({
        seenTipIds: new Set<FeatureTipId>(['cmd-j-palette']),
        completedTipIds: getCompletedFeatureTipIds({
          cliInstalled: true,
          voiceDictationEnabled: false,
          featureInteractions: { 'voice-dictation': { firstInteractedAt: 1, interactionCount: 1 } }
        })
      }),
    contract: {
      kind: 'parity',
      why: "[] is the twin's real 'nothing left to show', so a pre-ready one would open a tip for a feature the user already set up"
    }
  },
  {
    name: 'feature-tip-selection.getCompletedFeatureTipIds(interaction-completed)',
    call: () =>
      getCompletedFeatureTipIds({
        cliInstalled: false,
        voiceDictationEnabled: false,
        featureInteractions: { 'voice-dictation': { firstInteractedAt: 1, interactionCount: 1 } }
      }),
    contract: {
      kind: 'parity',
      why: 'the completion filter feeding the ordered list; only the completing interaction ids cross, so an unread persisted key cannot flip it'
    }
  },
  {
    name: 'feature-tip-selection.normalizeFeatureTipIds(persisted seen list)',
    call: () => normalizeFeatureTipIds(['orca-cli', 'gone', 'orca-cli', 'voice-dictation']),
    contract: {
      kind: 'parity',
      why: 'store hydration and main persistence both run this; a pre-ready [] hydrates an empty seen list that the next markFeatureTipsSeen persists over the real one'
    }
  },
  {
    name: 'feature-tip-selection.isFeatureTipId(catalog id)',
    call: () => isFeatureTipId('cmd-j-palette'),
    contract: {
      kind: 'parity',
      why: "a zod z.custom predicate in main's fail-closed client-UI validator — a pre-ready false rejects a legitimate ui.set write"
    }
  }
]

runShimPreReadyContractSuite(CASES)
