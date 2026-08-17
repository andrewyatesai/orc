// Module-global monotonic counter, bumped whenever a saved runtime environment's
// connection is retired (removed, re-paired, or its status dropped). Consumers stamp
// in-flight requests with the generation so a stale reply from a superseded connection
// can be discarded.
const connectionGenerationByEnvironment = new Map<string, number>()

export function getRuntimeEnvironmentConnectionGeneration(environmentId: string): number {
  return connectionGenerationByEnvironment.get(environmentId) ?? 0
}

/** Clears the module-global generation counters so a fresh test store starts from zero. */
export function clearRuntimeEnvironmentConnectionGenerationsForTests(): void {
  connectionGenerationByEnvironment.clear()
}

export function advanceRuntimeEnvironmentConnectionGeneration(environmentId: string): number {
  const next = getRuntimeEnvironmentConnectionGeneration(environmentId) + 1
  connectionGenerationByEnvironment.set(environmentId, next)
  return next
}
