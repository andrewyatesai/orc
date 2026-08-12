import type { IPtyProvider } from '../providers/types'
import { SessionNotFoundError } from './daemon-errors'

/** Attach-only session adoption that refuses the in-process fallback route. An
 *  unknown id resolves to the fallback, whose no-op attach would resolve and
 *  pin a subscriber-driven attach as succeeded while the stream stays blank —
 *  yet a fallback pty cannot own a daemon-surviving session by definition. So
 *  refuse; a later subscriber attaches once a daemon adapter proves the id. */
export async function attachDaemonOwnedSession(
  owner: IPtyProvider,
  fallback: IPtyProvider,
  sessionId: string
): Promise<void> {
  if (owner === fallback) {
    throw new SessionNotFoundError(sessionId)
  }
  await owner.attach(sessionId)
}

/** Probes providers for an id absent from the routing map and adopts the first
 *  proven owner into the map. */
export function adoptOwningProvider(
  sessionProviders: Map<string, IPtyProvider>,
  providers: readonly IPtyProvider[],
  sessionId: string
): IPtyProvider | null {
  for (const provider of providers) {
    if (provider.hasPty?.(sessionId) === true) {
      sessionProviders.set(sessionId, provider)
      return provider
    }
  }
  return null
}
