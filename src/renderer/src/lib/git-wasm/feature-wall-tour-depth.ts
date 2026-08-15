// Renderer feature-wall depth builders driven by the Rust orca_core port in
// orca-git wasm. Pre-ready summaries degrade to zero rather than guessing.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type {
  FeatureWallStepId,
  FeatureWallWorkflowId
} from '../../../../shared/feature-wall-workflows'
import type {
  FeatureWallTourDepthInput,
  FeatureWallTourDepthStep,
  FeatureWallTourDepthSummary
} from '../../../../shared/feature-wall-tour-depth'

// Why 'omit': `getFeatureWallTourDepthStep`'s `stepId` is optional and an absent
// key is the workflow-level lookup the Rust port reads as None.
function op(fn: string, input: unknown): unknown | null {
  if (!isGitWasmReady()) {
    return null
  }
  return dispatchToWasmCore('feature-wall-tour-depth', fn, input, {
    undefinedProperties: 'omit'
  })
}

export function getFeatureWallTourDepthStep(input: {
  workflowId: FeatureWallWorkflowId
  stepId?: FeatureWallStepId
}): FeatureWallTourDepthStep {
  const result = op('getFeatureWallTourDepthStep', input) as FeatureWallTourDepthStep | null
  return result ?? 'terminal'
}

export function buildFeatureWallTourDepthSummary(
  input: FeatureWallTourDepthInput
): FeatureWallTourDepthSummary {
  // Why: Sets serialize as empty objects, so flatten them before the JSON-only
  // wasm boundary used by both renderer telemetry and parity tests. (The codec
  // now rejects a raw Set outright rather than letting it arrive as {}.)
  const result = op('buildFeatureWallTourDepthSummary', {
    visitedWorkflows: [...input.visitedWorkflows],
    visitedSteps: [...input.visitedSteps],
    workflowDone: input.workflowDone,
    stepDone: input.stepDone,
    lastGroupId: input.lastGroupId
  }) as FeatureWallTourDepthSummary | null
  return (
    result ?? {
      visited_workflow_count: 0,
      visited_substep_count: 0,
      completed_workflow_count: 0,
      completed_substep_count: 0
    }
  )
}
