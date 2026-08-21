import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { normalizedUserText } from './mobile-native-chat-draft-reconcile'

const SPACE = ' '
const NO_PENDING_IDS: ReadonlySet<string> = new Set()
// Slack the cursor slide may spend re-trying later start positions, on top of
// one free pass over the run. Nothing bounds how many sends pile onto the
// agent's input line — that ends when the agent accepts input again — so the
// budget must never truncate a genuine glue: the first attempt covers the whole
// run and always fits. It only stops a run of identical prefix-matching sends
// from making the scan quadratic.
export const GLUE_SLIDE_BUDGET = 8

/** The subset of a pending echo the glue matcher reads. `reconcileLandedEchoes`
 *  keys the exact/image path off `normalizedText`, whereas glue matches the
 *  whitespace-collapsed raw `text` against a concatenated transcript row. */
type GluedPendingInput = {
  id: string
  text: string
  images?: string[]
  baselineTailMessageId: string | null
}

type UserTurn = { index: number; text: string }
type GlueSegment = { text: string; tail: number } | null

// A glued row can separate its sends with any whitespace the host echoed (tab,
// newline, repeated spaces), so both sides collapse to single spaces before the
// concatenation is matched. Kept private to this pass: the claim-based exact
// path deliberately matches verbatim normalized text and must not collapse.
function collapseGlueWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, SPACE)
}

/**
 * Ids of pending bubbles whose optimistic sends were glued into ONE transcript
 * user row — two fast sends writing the agent's input line before it submits
 * land as a single turn that exactly spells their normalized concatenation.
 *
 * The claim-based reconcile (`reconcileLandedEchoes`) only ever matches a
 * bubble's whole text against a whole echo, so a glued row matches neither send
 * and strands both. This second pass retires a run of 2+ adjacent text-only
 * bubbles when a row spells them out, with every send still bounded by its OWN
 * captured tail: a row that already existed when a send was issued can never be
 * part of its echo. Exact landings, image echoes and empty-text sends stay
 * barriers that preserve original adjacency.
 */
export function selectGluedPendingIds(
  messages: readonly NativeChatMessage[],
  pending: readonly GluedPendingInput[],
  excludedPendingIds: ReadonlySet<string> = NO_PENDING_IDS
): ReadonlySet<string> {
  const retired = new Set<string>()
  if (pending.length < 2) {
    return retired
  }
  const messageIndexById = new Map<string, number>()
  const turns: UserTurn[] = []
  for (const [index, message] of messages.entries()) {
    messageIndexById.set(message.id, index)
    const text = normalizedUserText(message)
    if (text) {
      turns.push({ index, text: collapseGlueWhitespace(text) })
    }
  }
  const segments: GlueSegment[] = pending.map((item) => {
    const text = collapseGlueWhitespace(item.text)
    const tail =
      item.baselineTailMessageId === null
        ? -1
        : (messageIndexById.get(item.baselineTailMessageId) ?? null)
    return excludedPendingIds.has(item.id) || item.images?.length || text === '' || tail === null
      ? null
      : { text, tail }
  })

  // Barriers preserve original adjacency after exact landings retire.
  let runStart = 0
  while (runStart < pending.length) {
    while (runStart < pending.length && segments[runStart] === null) {
      runStart += 1
    }
    let runEnd = runStart
    while (runEnd < pending.length && segments[runEnd] !== null) {
      runEnd += 1
    }
    let cursor = runStart
    for (const turn of turns) {
      if (cursor >= runEnd - 1) {
        break
      }
      // A send that can never match must not freeze the run behind it. One
      // permanently unretirable head — a pair whose own glued row arrived with
      // the read, or a send an older row already claimed — would otherwise
      // disable glue retirement for every later pair, for the rest of the
      // session. Slide past it; the cursor stays monotonic, so a later turn can
      // never claim a send an earlier one already took.
      let budget = runEnd - runStart + GLUE_SLIDE_BUDGET
      let start = cursor
      let matched = 0
      for (; start <= runEnd - 2 && budget > 0; start++) {
        const attempt = matchGluedRun(turn, segments, start, runEnd)
        budget -= attempt.inspected
        matched = attempt.matched
        if (matched > 0) {
          break
        }
      }
      if (matched === 0) {
        continue
      }
      for (let index = start; index < start + matched; index++) {
        retired.add(pending[index]!.id)
      }
      cursor = start + matched
    }
    runStart = runEnd + 1
  }
  return retired
}

/** Length of the exact glued run at `start`, plus the segments it had to read. */
function matchGluedRun(
  turn: UserTurn,
  segments: readonly GlueSegment[],
  start: number,
  end: number
): { matched: number; inspected: number } {
  let at = 0
  let matched = 0
  let inspected = 0
  for (let index = start; index < end; index++) {
    const segment = segments[index]!
    inspected += 1
    // Every send carries its OWN boundary: a row that already existed when this
    // send was issued can never be part of its echo, however well it reads.
    if (turn.index <= segment.tail) {
      return { matched: 0, inspected }
    }
    if (at > 0 && turn.text[at] === SPACE) {
      at += 1
    }
    if (!turn.text.startsWith(segment.text, at)) {
      return { matched: 0, inspected }
    }
    at += segment.text.length
    matched += 1
    if (at === turn.text.length) {
      // A lone exact match is an ordinary landing, which the claim pass owns.
      return { matched: matched > 1 ? matched : 0, inspected }
    }
  }
  return { matched: 0, inspected }
}
