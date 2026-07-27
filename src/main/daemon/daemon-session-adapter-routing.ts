import type { DaemonPtyAdapter } from './daemon-pty-adapter'

// Which daemon generation owns a PTY session: boot discovery of legacy sessions,
// startup reconciliation, and per-session route resolution over the routes map.

export async function discoverLegacySessionRoutes(
  legacy: DaemonPtyAdapter[],
  routes: Map<string, DaemonPtyAdapter>
): Promise<void> {
  for (const adapter of legacy) {
    try {
      const sessions = await adapter.listProcesses()
      for (const session of sessions) {
        routes.set(session.id, adapter)
      }
    } catch (error) {
      console.warn('[daemon] Failed to discover legacy daemon sessions', error)
    }
  }
}

export async function reconcileSessionRoutesOnStartup(
  adapters: DaemonPtyAdapter[],
  routes: Map<string, DaemonPtyAdapter>,
  validWorktreeIds: Set<string>
): Promise<{ alive: string[]; killed: string[] }> {
  const alive: string[] = []
  const killed: string[] = []
  for (const adapter of adapters) {
    const result = await adapter.reconcileOnStartup(validWorktreeIds)
    // Why: daemon startup can reconcile many restored sessions; spreading
    // those arrays into push can exceed JavaScript's argument limit.
    for (const id of result.alive) {
      alive.push(id)
    }
    for (const id of result.killed) {
      killed.push(id)
    }
    for (const id of result.alive) {
      routes.set(id, adapter)
    }
    for (const id of result.killed) {
      routes.delete(id)
    }
  }
  return { alive, killed }
}

export function resolveSessionAdapter(
  sessionId: string,
  routes: Map<string, DaemonPtyAdapter>,
  current: DaemonPtyAdapter,
  legacy: DaemonPtyAdapter[]
): DaemonPtyAdapter {
  const routed = routes.get(sessionId)
  if (routed) {
    return routed
  }
  // Why: reads fan out across all adapters, but this routing map is filled only
  // by one-shot boot discovery. A legacy session it missed had its writes silently
  // dropped onto `current`; self-heal by asking who actually owns the pty, then cache.
  for (const adapter of [current, ...legacy]) {
    if (adapter.hasPty(sessionId)) {
      routes.set(sessionId, adapter)
      return adapter
    }
  }
  return current
}

export function resolveInspectionAdapter(
  sessionId: string,
  routes: Map<string, DaemonPtyAdapter>,
  current: DaemonPtyAdapter,
  legacy: DaemonPtyAdapter[]
): DaemonPtyAdapter {
  const adapter =
    routes.get(sessionId) ?? [current, ...legacy].find((candidate) => candidate.hasPty(sessionId))
  if (!adapter) {
    throw new Error('terminal_gone')
  }
  routes.set(sessionId, adapter)
  return adapter
}
