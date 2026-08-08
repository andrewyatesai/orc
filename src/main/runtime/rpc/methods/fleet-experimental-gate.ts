/**
 * The experimental gate on R0's fleet verbs (§12 of
 * docs/reference/alab-auto-mode-design.md).
 *
 * These verbs let one agent type into another agent's terminal. That is the
 * point of the feature and also why it must not be reachable by accident while
 * the surrounding machinery (manager supervisor, gate policy, router) is still
 * being built. §13.5 graduates the flag to a real setting in R1.
 *
 * Refuses with a message that names the switch, because the caller is an agent
 * and a bare "method not found" would send it hunting for a typo.
 */

/** Structural on purpose: the runtime's settings accessor is typed narrower
 *  than GlobalSettings, and this gate only ever reads one flag. */
export type OrchestrationExperimentSettings = { experimentalOrchestration?: boolean }

export const ORCHESTRATION_EXPERIMENT_ENV_VAR = 'ORCA_EXPERIMENTAL_ORCHESTRATION'

/** Env override exists for headless `orca serve` and e2e, where no one can click
 *  a settings toggle. Deliberately opt-in only — it can enable, never disable. */
export function isOrchestrationExperimentEnabled(
  settings: OrchestrationExperimentSettings | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (settings?.experimentalOrchestration === true) {
    return true
  }
  const override = env[ORCHESTRATION_EXPERIMENT_ENV_VAR]
  return override === '1' || override === 'true'
}

export class OrchestrationExperimentDisabledError extends Error {
  constructor(method: string) {
    super(
      `${method} is an experimental fleet verb. Enable it with Settings → experimentalOrchestration, ` +
        `or ${ORCHESTRATION_EXPERIMENT_ENV_VAR}=1 for a headless runtime.`
    )
    this.name = 'OrchestrationExperimentDisabledError'
  }
}

export function assertOrchestrationExperimentEnabled(
  method: string,
  settings: OrchestrationExperimentSettings | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isOrchestrationExperimentEnabled(settings, env)) {
    throw new OrchestrationExperimentDisabledError(method)
  }
}
