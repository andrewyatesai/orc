/**
 * Hook evidence for the §5.2a submit verifier — it answers one question:
 * "since instant/sequence T, did a certified submit signal arrive for pane P,
 * and was any hook for P dropped?"
 *
 * Why a recorder rather than a poll: the enriched status tap carries no per-pane
 * sequence and `getStatusSnapshot` is last-status-per-pane, so a working→done
 * pair collapses between two polls. Arrivals are stamped as they land and the
 * query only reads what was already recorded.
 *
 * Why the drop half weighs as much as the arrival half: the ingest paths discard
 * hooks for panes Orca believes closed and still answer 204 (§5.2a, "one real
 * hole"), so "no hook arrived" and "a hook arrived and was discarded" are
 * different answers — `no` versus `unknown`, and only one of them may retry.
 *
 * Attribution is the input lease's job, not this module's: no hook payload says
 * which submission it belongs to, so the caller marks a cursor while it holds
 * the pane exclusively and reads the first certified arrival after it.
 *
 * Two consequences of that split, both load-bearing below. Certification that
 * depends on history — the opencode family's per-turn key — is decided by the
 * *cursor*, not by mutable pane state that `forgetPane()` or retention may
 * discard between the mark and the read. And every read of a window this
 * observer cannot vouch for reports `truncated`, because the caller maps an
 * unqualified empty window to `submitted: 'no'`, the one verdict that licenses a
 * second Enter into a live agent.
 *
 * Pure module: no Electron, no I/O, injectable clock.
 */
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import type { AgentStatusState, AgentType } from '../../shared/agent-status-types'
import {
  classifySubmitHookArrival,
  type SubmitEvidenceTier
} from './agent-submit-hook-classification'
import type { SuppressedClosedPaneHookRecord } from './closed-pane-hook-suppression'

import { droppedSinceOrigin, isAfterOrigin, shedOldest } from './agent-submit-hook-window'
export { agentTypeCertifiesSubmit } from './agent-submit-hook-classification'
export type { SubmitEvidenceTier } from './agent-submit-hook-classification'

/** Panes retained. Mirrors the server's own closed-set LRUs: a long-lived runtime churns
 *  through panes, and a verifier window is seconds wide. */
export const AGENT_SUBMIT_HOOK_PANES_MAX = 256

/** Submit-relevant arrivals kept per pane. One per turn in the normal case; the cap only
 *  binds when a nested child agent posts its own boundaries inside one window. */
export const AGENT_SUBMIT_HOOK_ARRIVALS_PER_PANE_MAX = 32

/** The enriched shape `AgentHookServer` publishes; its own alias is module-private. */
export type ObservedAgentHookEvent = AgentHookEventPayload & {
  receivedAt: number
  stateStartedAt: number
}

/** The slice of `AgentHookServer` this observer needs. Structural, so tests (and any
 *  headless caller) can supply their own without constructing a server. */
export type AgentHookEvidenceSource = {
  subscribeEnrichedStatus(listener: (payload: ObservedAgentHookEvent) => void): () => void
  getSuppressedHookRecord(paneKey: string): SuppressedClosedPaneHookRecord | undefined
}

/** Readonly because the query hands back the retained records themselves; a caller that
 *  edited one would be rewriting evidence. */
export type AgentSubmitHookArrival = {
  /** Observer-minted, strictly increasing across panes — the ordering the tap does not carry. */
  readonly sequence: number
  readonly paneKey: string
  /** Observer clock, not the payload's `receivedAt`: that is watermark-inflated on relayed panes (§5.2a). */
  readonly at: number
  readonly tier: SubmitEvidenceTier
  readonly agentType?: AgentType
  readonly hookEventName?: string
  readonly hasExplicitPrompt: boolean
  readonly promptInteractionKey?: string
  /** Certification rests on that key being new to the reading window (§5.2a opencode family),
   *  so the recorder files it as `observed` and `since()` promotes it against the cursor. */
  readonly certifiesOnNewPerTurnKey: boolean
  /** PTY incarnation identity, when the hook script posted one. */
  readonly launchToken?: string
  readonly state: AgentStatusState
}

export type SubmitEvidenceOrigin = {
  paneKey: string
  /** Wall-clock start. Used only when `sequence` is absent; the compare is `>=`, so it is
   *  as precise as the clock — prefer `mark()`. */
  instant: number
  /** From `mark()`. Exact, and immune to same-millisecond ties. */
  sequence?: number
  /** Drop-ledger baseline from `mark()`. The ledger is cumulative and survives pane reuse,
   *  so without a baseline the drop test rests on `lastSuppressedAt` alone. */
  suppressedCount?: number
  /** The ledger's own `lastSuppressedAt` at `mark()`. Compared only against the ledger's later
   *  stamp, so the drop test never measures a `Date.now()` ledger with an injected clock. */
  suppressedAt?: number
  /** The pane's last per-turn key at `mark()` (opencode family). Pinned into the cursor rather
   *  than read from pane state at query time because `forgetPane()`, retention and `stop()` all
   *  discard that state — and with no baseline a *redelivered* message part looks like a fresh
   *  submit. A bare origin pins none, so it can only be as good as the arrivals still retained. */
  lastPromptInteractionKey?: string
  /** Set when the observer cannot name a baseline *and* cannot rule out that it once had one:
   *  no per-turn key can be proven fresh, so none of them certifies and the window is lossy. */
  perTurnKeyHistoryLost?: boolean
  /** When set, arrivals stamped with a different incarnation are excluded (§5.2a launchToken). */
  launchToken?: string
}

/** An origin with everything `mark()` can pin down. */
export type SubmitObservationCursor = SubmitEvidenceOrigin & {
  sequence: number
  suppressedCount: number
}

export type SubmitEvidenceWindow = {
  paneKey: string
  /** Oldest first. §5.2a: the first is this operation's; a later one is a child's turn,
   *  never evidence of a second submission. */
  certified: readonly AgentSubmitHookArrival[]
  observed: readonly AgentSubmitHookArrival[]
  /** A hook for this pane was dropped after the origin — what separates `unknown` from `no`. */
  dropped: boolean
  /** The cumulative ledger entry, present whenever the pane has ever had a drop. */
  drop?: SuppressedClosedPaneHookRecord
  /** Arrivals excluded because their `launchToken` names another incarnation. */
  staleLaunchTokenCount: number
  /** The observer was not watching, or retention shed arrivals that may have fallen in this
   *  window; absence of evidence is not evidence of absence here. */
  truncated: boolean
}

type PaneRecord = {
  arrivals: AgentSubmitHookArrival[]
  /** Highest sequence per-pane retention has shed. */
  shedThroughSequence: number
  lastPromptInteractionKey?: string
}

/** Where a pane's records were thrown away, and the last per-turn key they held: an older
 *  cursor cannot be answered honestly, and a newer one still needs that key as its baseline. */
type DiscardedPane = { sequence: number; at: number; lastPromptInteractionKey?: string }

export class AgentSubmitHookObserver {
  private readonly panes = new Map<string, PaneRecord>()
  private readonly discardedPanes = new Map<string, DiscardedPane>()
  /** This ledger is bounded like the panes it shadows, so it sheds too; the watermark keeps the
   *  loss reportable after the record naming the pane is gone. */
  private discardedThrough: { sequence: number; at: number } | null = null
  /** Where the last `stop()` cut history. Nothing is recorded while unsubscribed, so a cursor
   *  spanning it cannot be answered — silence there would read as a false `no`. */
  private cleared: { sequence: number; at: number } | null = null
  /** Tripped when the ledger sheds a record that named a per-turn key. The pane it belonged to is
   *  no longer nameable, so from here on any pane with no baseline may be that one. */
  /** Sequence at which the ledger shed a record that named a per-turn key. A pane with no
   *  baseline may be that pane — but only if it existed by then, so this is a watermark
   *  rather than a latch: blinding every pane forever would refuse the first submit on
   *  panes created long after the shed, which cannot be redeliveries of it. */
  private perTurnKeyBaselineShedThrough = -1
  private readonly now: () => number
  private readonly maxPanes: number
  private readonly maxArrivalsPerPane: number
  private unsubscribe: (() => void) | null = null
  private sequence = 0

  constructor(
    private readonly source: AgentHookEvidenceSource,
    options?: { now?: () => number; maxPanes?: number; maxArrivalsPerPane?: number }
  ) {
    this.now = options?.now ?? Date.now
    this.maxPanes = options?.maxPanes ?? AGENT_SUBMIT_HOOK_PANES_MAX
    this.maxArrivalsPerPane = options?.maxArrivalsPerPane ?? AGENT_SUBMIT_HOOK_ARRIVALS_PER_PANE_MAX
  }

  /** Idempotent: a second call keeps the one subscription. */
  start(): void {
    if (this.unsubscribe) {
      return
    }
    this.unsubscribe = this.source.subscribeEnrichedStatus((event) => {
      this.record(event)
    })
  }

  /** Drops the subscription, not the evidence. `cleared` already answers every cursor that spans
   *  the cut, while the per-turn keys are what keeps a redelivered message part from certifying as
   *  a fresh submit after a restart — throwing them away blinded every pane the observer held. */
  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    // Why the tick: the cut must sort strictly after every cursor taken before it, even when no
    // arrival separated them.
    this.sequence++
    this.cleared = { sequence: this.sequence, at: this.now() }
  }

  /** Take before arming a submit, while the caller holds the pane's input lease. */
  mark(paneKey: string): SubmitObservationCursor {
    const pane = this.panes.get(paneKey)
    const baseline =
      pane?.lastPromptInteractionKey ?? this.discardedPanes.get(paneKey)?.lastPromptInteractionKey
    const drop = this.source.getSuppressedHookRecord(paneKey)
    return {
      paneKey,
      sequence: this.sequence,
      instant: this.now(),
      suppressedCount: drop?.count ?? 0,
      ...(drop ? { suppressedAt: drop.lastSuppressedAt } : {}),
      ...(baseline === undefined ? {} : { lastPromptInteractionKey: baseline }),
      // Why not "no baseline means no prior key": once the ledger has shed a record that named a
      // key, a pane the observer knew of by then may BE that pane, and its next key cannot be
      // proven fresh. A pane first seen after the shed cannot be, so it keeps its rights.
      ...(baseline === undefined && this.perTurnKeyBaselineWasShedFor(pane)
        ? { perTurnKeyHistoryLost: true }
        : {})
    }
  }

  /** True when this pane could be one whose key baseline the ledger shed. An unknown pane
   *  counts (it may be the shed one); a pane whose first arrival came after the shed does not. */
  private perTurnKeyBaselineWasShedFor(pane: PaneRecord | undefined): boolean {
    if (this.perTurnKeyBaselineShedThrough < 0) {
      return false
    }
    const firstSeen = pane?.arrivals[0]?.sequence
    return firstSeen === undefined || firstSeen <= this.perTurnKeyBaselineShedThrough
  }

  since(origin: SubmitEvidenceOrigin): SubmitEvidenceWindow {
    const pane = this.panes.get(origin.paneKey)
    const certified: AgentSubmitHookArrival[] = []
    const observed: AgentSubmitHookArrival[] = []
    let staleLaunchTokenCount = 0
    const seenKeys = new Set(
      origin.lastPromptInteractionKey === undefined ? [] : [origin.lastPromptInteractionKey]
    )
    for (const arrival of pane?.arrivals ?? []) {
      const otherIncarnation =
        origin.launchToken !== undefined &&
        arrival.launchToken !== undefined &&
        arrival.launchToken !== origin.launchToken
      if (!isAfterOrigin(arrival, origin)) {
        // A key seen before the cursor is this pane's history, not this operation's submit.
        if (!otherIncarnation && arrival.promptInteractionKey !== undefined) {
          seenKeys.add(arrival.promptInteractionKey)
        }
        continue
      }
      if (otherIncarnation) {
        staleLaunchTokenCount++
        continue
      }
      const judged = this.judgePerTurnKey(arrival, origin, seenKeys)
      ;(judged.tier === 'certified' ? certified : observed).push(judged)
    }
    const drop = this.source.getSuppressedHookRecord(origin.paneKey)
    return {
      paneKey: origin.paneKey,
      certified,
      observed,
      dropped: droppedSinceOrigin(drop, origin),
      ...(drop ? { drop } : {}),
      staleLaunchTokenCount,
      // Nothing is recorded while unsubscribed, so an unwatched window is blind, not empty — and
      // so is one where a key was refused for want of a baseline: that empty `certified` is a
      // window this observer could not read, and an unqualified empty licenses a second Enter.
      truncated:
        this.unsubscribe === null ||
        (origin.perTurnKeyHistoryLost === true &&
          observed.some((entry) => entry.certifiesOnNewPerTurnKey)) ||
        this.lostEvidenceSince(origin, pane)
    }
  }

  /** Release a pane the caller knows is finished with; retention would otherwise hold it
   *  until the LRU sheds it. Not a silent release: the discard ledger keeps the position and
   *  the last per-turn key, so an older cursor still reports the loss and a redelivered
   *  message part cannot certify as a fresh submit afterwards. */
  forgetPane(paneKey: string): void {
    const pane = this.panes.get(paneKey)
    if (!pane) {
      return
    }
    this.panes.delete(paneKey)
    this.noteDiscardedPane(paneKey, pane)
  }

  /** Diagnostics: panes currently retained. */
  get trackedPaneCount(): number {
    return this.panes.size
  }

  private record(event: ObservedAgentHookEvent): void {
    // Why: a relay cache replay is a rebroadcast of an old hook, and a session-identity refresh
    // carries placeholder status fields — neither is a submission.
    if (event.isReplay === true || event.providerSessionOnly === true || !event.paneKey) {
      return
    }
    const classification = classifySubmitHookArrival({
      agentType: event.payload.agentType,
      hookEventName: event.hookEventName,
      hasExplicitPrompt: event.hasExplicitPrompt === true,
      hasPerTurnKey: event.promptInteractionKey !== undefined
    })
    if (classification === null && event.promptInteractionKey === undefined) {
      return
    }
    const pane = this.touchPane(event.paneKey, this.panes.get(event.paneKey))
    if (event.promptInteractionKey !== undefined) {
      pane.lastPromptInteractionKey = event.promptInteractionKey
    }
    if (classification === null) {
      return
    }
    this.sequence++
    pane.arrivals.push({
      sequence: this.sequence,
      paneKey: event.paneKey,
      at: this.now(),
      tier: classification.tier,
      certifiesOnNewPerTurnKey: classification.certifiesOnNewPerTurnKey,
      agentType: event.payload.agentType,
      hookEventName: event.hookEventName,
      hasExplicitPrompt: event.hasExplicitPrompt === true,
      promptInteractionKey: event.promptInteractionKey,
      launchToken: event.launchToken,
      state: event.payload.state
    })
    while (pane.arrivals.length > this.maxArrivalsPerPane) {
      const shed = pane.arrivals.shift()
      if (shed) {
        pane.shedThroughSequence = shed.sequence
      }
    }
  }

  /** The recorder cannot decide this family's tier: freshness is relative to the reader's
   *  baseline, and a key already seen in this window is another part of the turn in flight. */
  private judgePerTurnKey(
    arrival: AgentSubmitHookArrival,
    origin: SubmitEvidenceOrigin,
    seenKeys: Set<string>
  ): AgentSubmitHookArrival {
    const key = arrival.promptInteractionKey
    if (key === undefined) {
      return arrival
    }
    const certifies =
      arrival.certifiesOnNewPerTurnKey &&
      origin.perTurnKeyHistoryLost !== true &&
      !seenKeys.has(key)
    seenKeys.add(key)
    return certifies ? { ...arrival, tier: 'certified' } : arrival
  }

  private touchPane(paneKey: string, existing: PaneRecord | undefined): PaneRecord {
    const pane = existing ?? { arrivals: [], shedThroughSequence: 0 }
    // Delete-then-set keeps the most recently active pane last so eviction sheds only the oldest.
    this.panes.delete(paneKey)
    this.panes.set(paneKey, pane)
    shedOldest(this.panes, this.maxPanes, (shedKey, shedPane) => {
      this.noteDiscardedPane(shedKey, shedPane)
    })
    return pane
  }

  private noteDiscardedPane(paneKey: string, pane: PaneRecord): void {
    // Why the tick, as in `stop()`: the discard must sort strictly after every cursor taken
    // before it, even when no arrival separated them.
    this.sequence++
    // Read before the delete, and carried: a pane re-tracked by a key-less arrival has no key of
    // its own, so overwriting its record with one would hand a redelivered part a fresh baseline.
    const carriedKey =
      pane.lastPromptInteractionKey ?? this.discardedPanes.get(paneKey)?.lastPromptInteractionKey
    this.discardedPanes.delete(paneKey)
    this.discardedPanes.set(paneKey, {
      sequence: this.sequence,
      at: this.now(),
      ...(carriedKey === undefined ? {} : { lastPromptInteractionKey: carriedKey })
    })
    shedOldest(this.discardedPanes, this.maxPanes, (_key, shed) => {
      this.discardedThrough = { sequence: shed.sequence, at: shed.at }
      if (shed.lastPromptInteractionKey !== undefined) {
        this.perTurnKeyBaselineShedThrough = Math.max(
          this.perTurnKeyBaselineShedThrough,
          this.sequence
        )
      }
    })
  }

  private lostEvidenceSince(origin: SubmitEvidenceOrigin, pane: PaneRecord | undefined): boolean {
    if (this.cleared && isAfterOrigin(this.cleared, origin)) {
      return true
    }
    if (this.discardedThrough && isAfterOrigin(this.discardedThrough, origin)) {
      return true
    }
    const discarded = this.discardedPanes.get(origin.paneKey)
    if (discarded && isAfterOrigin(discarded, origin)) {
      return true
    }
    if (!pane || pane.shedThroughSequence === 0) {
      return false
    }
    return origin.sequence === undefined
      ? (pane.arrivals[0]?.at ?? Number.POSITIVE_INFINITY) > origin.instant
      : pane.shedThroughSequence > origin.sequence
  }
}

/** The ledger is cumulative and outlives pane reuse, so a bare record is not a fresh drop. A
 *  marked cursor pins both of the ledger's own fields and compares against those — the count
 *  moves on every drop, and the timestamp catches an evicted-then-re-recorded entry whose count
 *  restarted at the baseline. A bare origin has neither, so it falls back to its caller's
 *  wall-clock instant. */
