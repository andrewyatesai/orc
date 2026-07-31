import type { AgentHookSource } from '../../shared/agent-hook-relay'

// Why: mirrors CLOSED_AGENT_STATUS_{TAB_IDS,PANE_KEYS}_MAX — this ledger shadows those LRUs, so it must shed entries the same way.
export const SUPPRESSED_CLOSED_PANE_HOOKS_MAX = 1024

// Why cap the name: relay payloads supply it, and 1024 retained entries × an unbounded
// string is memory a closed pane previously cost nothing.
const HOOK_EVENT_NAME_MAX = 64

/** Ingest path a dropped hook arrived on. `terminal` is an OSC status parse rather than a
 *  hook arrival, so it is accepted by the predicate but never recorded — see the server. */
export type SuppressedHookIngest = 'http' | 'relay' | 'terminal'

export type SuppressedHookContext = {
  ingest: SuppressedHookIngest
  /** Agent CLI that posted, when the ingest path names one. */
  source?: AgentHookSource
  /** Raw hook event name (e.g. `UserPromptSubmit`), when the payload carried one. */
  hookEventName?: string
}

export type SuppressedClosedPaneHookRecord = {
  /** Hooks dropped for this pane since it was first recorded (or since its last eviction). */
  count: number
  lastSuppressedAt: number
  lastIngest: SuppressedHookIngest
  lastSource?: AgentHookSource
  lastHookEventName?: string
}

export type SuppressedClosedPaneHookEntry = SuppressedClosedPaneHookRecord & { paneKey: string }

/** Bounded ledger of agent hooks dropped because Orca believes the target pane is closed.
 *  The HTTP path answers 204 either way, so without this a genuine `UserPromptSubmit` leaves
 *  no trace and a submit verifier cannot tell "no hook ever arrived" (the submission did not
 *  land) from "a hook arrived and Orca dropped it" (it may well have landed) — see
 *  docs/reference/alab-auto-mode-design.md §5.2a. Observability only: nothing here changes
 *  whether a hook is suppressed. */
export class ClosedPaneHookSuppressionLog {
  private readonly recordsByPaneKey = new Map<string, SuppressedClosedPaneHookRecord>()

  record(paneKey: string, context: SuppressedHookContext, now = Date.now()): void {
    const previous = this.recordsByPaneKey.get(paneKey)
    const hookEventName = context.hookEventName?.trim().slice(0, HOOK_EVENT_NAME_MAX)
    // Delete-then-set keeps the most recently suppressed pane last so eviction sheds only the oldest.
    this.recordsByPaneKey.delete(paneKey)
    this.recordsByPaneKey.set(paneKey, {
      count: (previous?.count ?? 0) + 1,
      lastSuppressedAt: now,
      lastIngest: context.ingest,
      ...(context.source ? { lastSource: context.source } : {}),
      ...(hookEventName ? { lastHookEventName: hookEventName } : {})
    })
    while (this.recordsByPaneKey.size > SUPPRESSED_CLOSED_PANE_HOOKS_MAX) {
      const oldest = this.recordsByPaneKey.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.recordsByPaneKey.delete(oldest)
    }
  }

  get(paneKey: string): SuppressedClosedPaneHookRecord | undefined {
    const record = this.recordsByPaneKey.get(paneKey)
    // Why: copy — callers poll this across turns and must not be able to mutate the ledger.
    return record ? { ...record } : undefined
  }

  /** Oldest-suppressed pane first, matching eviction order. */
  snapshot(): SuppressedClosedPaneHookEntry[] {
    return Array.from(this.recordsByPaneKey, ([paneKey, record]) => ({ paneKey, ...record }))
  }

  clear(): void {
    this.recordsByPaneKey.clear()
  }
}
