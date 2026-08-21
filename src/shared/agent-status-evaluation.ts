// The five behavioural exports of `agent-status-types` on the Rust
// `orca_agents::agent_status_types` core: parse/normalize an untrusted agent
// status payload, and the three predicates that read a status entry
// (dispatch settlement, freshness, subagent-list equality).
//
// This sits on `orca-dispatch-seam` rather than in a surface binding directory
// because the twin was a `src/shared` module reached from EVERY surface: main
// (`agent-hooks/server.ts`, `runtime/orca-runtime.ts`) and the SSH/WSL hook
// relay through `agent-hook-listener.ts` (napi / wasm-initSync, both bound
// synchronously at bootstrap), the renderer (`hooks/useIpcEvents.ts`,
// `terminal-pane/pty-connection.ts`, `terminal-pane/use-notification-dispatch.ts`,
// `lib/agent-hibernation-planner.ts`, `lib/worktree-activity-state.ts`,
// `store/slices/agent-status.ts`) where the seam is UNBOUND until wasm init, and
// `src/shared` itself (`agent-status-osc.ts`, `agent-status-identity.ts`), which
// runs on both. If wasm never lands, the renderer fallback is the answer for the
// whole session, not for a boot blip.
//
// PRE-READY CONTRACT — `parity` x5, and it is FORCED, not tidy. Every answer
// lands somewhere with no spare state:
//  * `parseAgentStatusPayload` / `normalizeAgentStatusPayload` already return
//    the twin's real `null` for "not a status payload", and their result is
//    PERSISTED (main writes it to last-status.json), routed by `paneKey` through
//    Map/record lookups, and equality-compared field by field before the store
//    fans out. `undefined` is not a usable sentinel either: every caller writes
//    `if (!payload) return`, so a signal would be read as "malformed" and would
//    silently DROP a real status event.
//  * The three predicates are bare booleans read inside `if`, and `false` is the
//    twin's own answer for "not fresh" / "settled" / "changed".
// So each fallback recomputes the deleted twin's body verbatim over the parts
// that stay in TypeScript: the caps and tables kept in `agent-status-types.ts`,
// the field normalizers in `agent-status-field-normalization.ts` and the
// pre-parse guard in `json-text-structure-limit.ts`. Those three modules are NOT
// dispatchers — a fallback that dispatches is not a fallback.
//
// The fallback is computed LAZILY, not eagerly, because the twin's body IS the
// cost this port exists to move (measured napi vs twin: normalize 3.8us vs
// 451ns small, 161us vs 90us with a 50 KB assistant message). Eager evaluation
// would pay the whole twin on every hook event. Two places still act BEFORE the
// dispatch, because there the twin throws or the adapter refuses: reading
// `entry.orchestration` (a nullish entry is the twin's own TypeError) and
// `subagentsCanCross`. Three more would-be type guards were written, watched
// NOT failing when removed, and deleted — the null collapse already covers
// them, and a guard no test can redden is not a guard.
//
// PROVED, not asserted: 29,424 fallback-vs-core comparisons against BOTH shipped
// artifacts — every one of 37 text shapes in each of the 7 string fields across
// all 8 state values on both entry points, the ECMA trim set (incl. U+FEFF,
// U+0085, U+3000, U+2028/9) leading/trailing, non-strings in every field, the
// interrupted/launchFailed x state matrix, the pre-parse token and depth
// bounds, escaped and raw lone surrogates, out-of-range and 20-digit numbers,
// duplicate keys, the subagent id/state/startedAt cross product plus the 32-row
// cap, 625 subagent-equality operand pairs, the full `updatedAt`/`staleAfterMs`
// ToNumber coercion matrix over 8 clocks, non-encodable NaN/Infinity/-0
// arguments, and 4k randomized payloads — 0 divergences. The corpus is
// discriminating: dropping the null collapse reddens 5,096 (parse) and 8,702
// (normalize) cases, returning the core answer unreshaped 5,096, dropping
// `subagentsCanCross` 426, and letting the core default `staleAfterMs` 846.
//
// Collapsing a `null` core answer onto the fallback is what makes this shim
// parity rather than "parity on the inputs serde likes", and it is the reason
// two of the three divergences the core carries are UNREACHABLE from here:
//  * A lone UTF-16 surrogate. Raw in the text, `encodeDispatchPayload` refuses
//    it (not valid UTF-8, so Rust cannot parse the payload at all); as the six
//    ASCII characters of a `\ud800` escape it crosses and `serde_json` refuses
//    the whole document. Either way nothing normalized crosses back, the shim
//    falls back, and the answer is the twin's — verified against the shipped
//    `orca_node.node`, which answers `null` where the twin answers
//    `{state:'working',prompt:'\ud800'}`.
//  * An out-of-range JSON number (`1e999`). `serde_json` errors, the core
//    answers `null`, the fallback answers the twin's payload. Reachable: OSC
//    9999 text is agent-authored.
//
// DECLARED RESIDUAL — one divergence IS reachable and is NOT repaired here,
// because the core returns a well-formed payload and nothing at the seam
// distinguishes it from a real answer. `normalizeSingleLinePreview` bounds its
// source scan at `maxLength * 8 + 64` UTF-16 code units; when a surrogate pair
// straddles that bound the twin emits the DANGLING HIGH SURROGATE and the core,
// whose answer must be a Rust `String`, emits U+FFFD.
// MEASURED against both shipped artifacts (`orca_node.node` and
// `orca_git_wasm_bg.wasm`), 70 boundary probes over every capped field at
// offsets -2..+2: 10 divergent, and they are exactly the five SINGLE-LINE
// fields on both entry points — `prompt` (bound 1664), `agentType` (384),
// `model` (1024), `toolName` (544), `toolInput` (1344) — each at the single
// offset where the high surrogate sits at `bound - 1`. `lastAssistantMessage`
// is clean (the multiline normalizer scans to the trimmed end, not to a cap)
// and so is `interactivePrompt` (never scanned). Both artifacts agree with each
// other; only the twin differs.
// Reachable: OSC 9999 payload text is agent-authored and hook bodies arrive off
// the SSH/relay wire. The consequence is bounded to one replacement glyph in a
// preview string that IS persisted and equality-compared, so it can cost one
// extra store fanout — not a dropped update. A stated gap beats a hidden one;
// closing it needs a core that can carry unpaired UTF-16.
//
// The result SHAPE is rebuilt here rather than handed back as the core decoded
// it: the twin's object literal always carries all eleven keys (`undefined` for
// an absent optional) and `JSON.stringify` drops exactly those, so a core answer
// used directly would differ from the twin under `Object.keys`, `in` and spread.
// Same for the six keys of every subagent snapshot.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import {
  normalizeInteractivePromptField,
  normalizeOptionalField,
  normalizeOptionalMultilineField,
  normalizePromptField,
  normalizeTurnCompletedAtField
} from './agent-status-field-normalization'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { overlayTurnCompletedAt } from './agent-status-turn-completed-overlay'
import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH,
  AGENT_STATUS_JSON_STRUCTURE_LIMITS,
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_STATUS_STALE_AFTER_MS,
  AGENT_STATUS_STATES,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH,
  AGENT_SUBAGENT_ID_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  SETTLED_DISPATCH_STATUSES,
  type AgentStatusEntry,
  type AgentStatusOrchestrationContext,
  type AgentStatusState,
  type AgentSubagentSnapshot,
  type AgentSubagentState,
  type ParsedAgentStatusPayload
} from './agent-status-types'

const AGENT_STATUS_TYPES = 'agent-status-types'

// Why ReadonlySet<string>: .has() accepts any string without a cast here; the
// narrowing cast stays on the return line where it is proven safe.
const VALID_STATES: ReadonlySet<string> = new Set<string>(AGENT_STATUS_STATES)

/** `null` means "the seam is unbound, or the payload cannot cross" — never an
 *  answer. Only the encode rejection is caught; a `DispatchCoreError` (the core
 *  reached, the function missing) still propagates, because a dead core must not
 *  read as a normal degrade. */
function dispatchAgentStatus(fn: string, input: unknown, root: string): unknown | null {
  try {
    return tryOrcaDispatch(AGENT_STATUS_TYPES, fn, input, {
      root,
      // Why safe for this module: every field the twin reads is guarded by
      // `typeof x !== 'string'` / `=== true` / `typeof x === 'number'`, so an
      // own property set to `undefined` is indistinguishable from an absent one
      // — which is exactly serde's `Option<T>`.
      undefinedProperties: 'omit'
    })
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

/** The deleted twin's body, verbatim over the kept caps. */
function legacyNormalizeSubagentSnapshot(value: unknown): AgentSubagentSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.id !== 'string') {
    return null
  }
  const id = obj.id.trim()
  if (id.length === 0 || id.length > AGENT_SUBAGENT_ID_MAX_LENGTH) {
    return null
  }
  if (
    obj.state !== 'working' &&
    obj.state !== 'blocked' &&
    obj.state !== 'waiting' &&
    obj.state !== 'idle'
  ) {
    return null
  }
  return {
    id,
    state: obj.state,
    startedAt:
      typeof obj.startedAt === 'number' && Number.isFinite(obj.startedAt) ? obj.startedAt : 0,
    agentType: normalizeOptionalField(obj.agentType, AGENT_TYPE_MAX_LENGTH),
    model: normalizeOptionalField(obj.model, AGENT_MODEL_MAX_LENGTH),
    description: normalizeOptionalField(obj.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  }
}

/** The deleted twin's body, verbatim. */
function legacyNormalizeSubagentsField(value: unknown): AgentSubagentSnapshot[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined
  }
  const normalized: AgentSubagentSnapshot[] = []
  for (const item of value) {
    const snapshot = legacyNormalizeSubagentSnapshot(item)
    if (snapshot) {
      normalized.push(snapshot)
      if (normalized.length >= AGENT_STATUS_MAX_SUBAGENTS) {
        break
      }
    }
  }
  return normalized.length > 0 ? normalized : undefined
}

/** The deleted twin's body, verbatim over the kept caps and normalizers. */
function legacyNormalizeAgentStatusObject(parsed: unknown): ParsedAgentStatusPayload | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.state !== 'string') {
    return null
  }
  const state = obj.state
  if (!VALID_STATES.has(state)) {
    return null
  }
  return {
    state: state as AgentStatusState,
    prompt: normalizePromptField(obj.prompt),
    agentType: normalizeOptionalField(obj.agentType, AGENT_TYPE_MAX_LENGTH),
    model: normalizeOptionalField(obj.model, AGENT_MODEL_MAX_LENGTH),
    toolName: normalizeOptionalField(obj.toolName, AGENT_STATUS_TOOL_NAME_MAX_LENGTH),
    toolInput: normalizeOptionalField(obj.toolInput, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH),
    interactivePrompt: normalizeInteractivePromptField(
      obj.interactivePrompt,
      AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH
    ),
    lastAssistantMessage: normalizeOptionalMultilineField(
      obj.lastAssistantMessage,
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
    ),
    interrupted: obj.interrupted === true && state === 'done' ? true : undefined,
    launchFailed: obj.launchFailed === true && state === 'done' ? true : undefined,
    turnCompletedAt: normalizeTurnCompletedAtField(obj.turnCompletedAt, state),
    subagents: legacyNormalizeSubagentsField(obj.subagents)
  }
}

/** The deleted twin's body, verbatim over the kept structure limits. */
function legacyParseAgentStatusPayload(json: string): ParsedAgentStatusPayload | null {
  try {
    assertJsonTextStructureWithinLimits(json, AGENT_STATUS_JSON_STRUCTURE_LIMITS)
    return legacyNormalizeAgentStatusObject(JSON.parse(json))
  } catch {
    return null
  }
}

/** The deleted twin's body, verbatim over the kept settled-status table. */
function legacyHasUnsettledOrUnknownDispatch(entry: {
  orchestration?: AgentStatusOrchestrationContext
}): boolean {
  if (!entry.orchestration) {
    return false
  }
  return !SETTLED_DISPATCH_STATUSES.some(
    (settled) => settled === entry.orchestration?.dispatchStatus
  )
}

/** The deleted twin's body, verbatim. */
function legacyIsFreshNonDoneAgentStatus(
  entry: Pick<AgentStatusEntry, 'state' | 'updatedAt'> | undefined,
  now: number,
  staleAfterMs: number
): boolean {
  return Boolean(entry && entry.state !== 'done' && now - entry.updatedAt <= staleAfterMs)
}

/** The deleted twin's body, verbatim. */
function legacyAgentSubagentsEqual(
  a: AgentSubagentSnapshot[] | undefined,
  b: AgentSubagentSnapshot[] | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return !a && !b
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.state !== y.state ||
      x.startedAt !== y.startedAt ||
      x.agentType !== y.agentType ||
      x.model !== y.model ||
      x.description !== y.description
    ) {
      return false
    }
  }
  return true
}

/** Rebuild the twin's six-key snapshot literal from the core's lean object. */
function shapeSubagents(value: unknown): AgentSubagentSnapshot[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.map((item) => {
    const raw = item as Record<string, unknown>
    return {
      id: raw.id as string,
      state: raw.state as AgentSubagentState,
      startedAt: raw.startedAt as number,
      agentType: raw.agentType as string | undefined,
      model: raw.model as string | undefined,
      description: raw.description as string | undefined
    }
  })
}

/** Rebuild the twin's twelve-key payload literal from the core's lean object.
 *  `turnCompletedAt` is undefined here — the shipped core predates the field —
 *  and the overlay stamps the real value from the original input. */
function shapePayload(answer: unknown): ParsedAgentStatusPayload {
  const raw = answer as Record<string, unknown>
  return {
    state: raw.state as AgentStatusState,
    prompt: raw.prompt as string,
    agentType: raw.agentType as string | undefined,
    model: raw.model as string | undefined,
    toolName: raw.toolName as string | undefined,
    toolInput: raw.toolInput as string | undefined,
    interactivePrompt: raw.interactivePrompt as string | undefined,
    lastAssistantMessage: raw.lastAssistantMessage as string | undefined,
    interrupted: raw.interrupted as true | undefined,
    launchFailed: raw.launchFailed as true | undefined,
    turnCompletedAt: raw.turnCompletedAt as number | undefined,
    subagents: shapeSubagents(raw.subagents)
  }
}

/**
 * Parse and validate an agent status JSON payload received from explicit hook
 * integrations or OSC 9999. Returns null if the payload is malformed or has an
 * invalid state.
 */
export function parseAgentStatusPayload(json: string): ParsedAgentStatusPayload | null {
  // No non-string type guard, and that is deliberate. The twin's body hands the
  // value to `JSON.parse`, which STRINGIFIES it, so
  // `parseAgentStatusPayload(['{"state":"working"}'])` answers a payload where
  // the adapter's `as_str` reads a non-string as absent — but "absent" IS the
  // core's null, and the collapse below already recomputes the twin's answer for
  // it. A guard here could never be watched failing, so it is not written.
  const answer = dispatchAgentStatus('parseAgentStatusPayload', json, 'json')
  if (answer === null) {
    return legacyParseAgentStatusPayload(json)
  }
  const shaped = shapePayload(answer)
  // Substring gate so payloads without the field never pay a second parse.
  if (json.includes('"turnCompletedAt"')) {
    try {
      overlayTurnCompletedAt(shaped, JSON.parse(json))
    } catch {
      // The core already parsed it; a reparse failure cannot demote the answer.
    }
  }
  return shaped
}

/**
 * Normalize an already-structured agent status object (e.g. from IPC, already
 * deserialized by Electron). Skips the JSON round trip `parseAgentStatusPayload`
 * needs — hook events can fire many times per second during a tool-use run.
 */
export function normalizeAgentStatusPayload(payload: unknown): ParsedAgentStatusPayload | null {
  const answer = dispatchAgentStatus('normalizeAgentStatusPayload', payload, 'payload')
  return answer === null
    ? legacyNormalizeAgentStatusObject(payload)
    : overlayTurnCompletedAt(shapePayload(answer), payload)
}

/**
 * Why: provider done hooks can fire mid-Dispatch, so only runtime-confirmed
 * settlement makes sleeping a pane safe. An absent status counts as unsettled on
 * purpose — a hook-only context proves nothing about the dispatch.
 */
export function hasUnsettledOrUnknownDispatch(entry: {
  orchestration?: AgentStatusOrchestrationContext
}): boolean {
  // Why only `orchestration` crosses: it is the single field both sides read,
  // and a live AgentStatusEntry carries a 20-row history beside it. Reading it
  // here is ALSO the nullish check — the twin reads `.orchestration` with no
  // optional chain, so a nullish entry is a TypeError and that throw is the
  // answer every caller gets, while the adapter would read an absent key and
  // answer false. A separate guard would be untestable, so the extraction
  // carries it.
  const answer = dispatchAgentStatus(
    'hasUnsettledOrUnknownDispatch',
    { orchestration: entry.orchestration },
    'entry'
  )
  return answer === null ? legacyHasUnsettledOrUnknownDispatch(entry) : (answer as boolean)
}

export function isFreshNonDoneAgentStatus(
  entry: Pick<AgentStatusEntry, 'state' | 'updatedAt'> | undefined,
  now = Date.now(),
  staleAfterMs = AGENT_STATUS_STALE_AFTER_MS
): boolean {
  // Why `now` is stamped here and always sent: the core REFUSES the call
  // without it (`Date.now()` is a clock read it cannot reproduce), so the
  // default has to be evaluated on this side of the seam.
  // Why only two fields cross: an AgentStatusEntry carries up to 20 history
  // rows plus subagents and provider metadata, and neither the twin nor the
  // core reads anything but `state` and `updatedAt`. A truthy non-object entry
  // is passed through untouched — the twin reads `undefined` off it and the
  // core's `get()` answers None, which is the same `NaN <= x` false.
  const isEntryObject = typeof entry === 'object' && entry !== null
  const crossableEntry = isEntryObject ? { state: entry.state, updatedAt: entry.updatedAt } : entry
  const answer = dispatchAgentStatus(
    'isFreshNonDoneAgentStatus',
    { entry: crossableEntry, now, staleAfterMs },
    'freshness'
  )
  return answer === null
    ? legacyIsFreshNonDoneAgentStatus(entry, now, staleAfterMs)
    : (answer as boolean)
}

/** True when the core can be asked: the twin duck-types `.length`/`[i]` off a
 *  truthy non-array and dereferences a null element, and the adapter refuses
 *  both rather than guessing — a refusal that THROWS once the seam is bound.
 *  An object-valued compared field is refused too: the twin's `!==` is a
 *  reference test the core cannot see. */
function subagentsCanCross(a: unknown, b: unknown): boolean {
  if ((a && !Array.isArray(a)) || (b && !Array.isArray(b))) {
    return false
  }
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return true
  }
  for (let i = 0; i < a.length; i++) {
    if (!subagentRowCanCross(a[i]) || !subagentRowCanCross(b[i])) {
      return false
    }
  }
  return true
}

const SUBAGENT_EQUALITY_FIELDS = ['id', 'state', 'startedAt', 'agentType', 'model', 'description']

function subagentRowCanCross(row: unknown): boolean {
  if (row === null || row === undefined) {
    return false
  }
  const record = row as Record<string, unknown>
  for (const field of SUBAGENT_EQUALITY_FIELDS) {
    const value = record[field]
    if (value !== null && typeof value === 'object') {
      return false
    }
  }
  return true
}

/** Structural equality for subagent lists so stores can reuse the previous
 *  array reference (and skip fanout) when nothing actually changed. */
export function agentSubagentsEqual(
  a: AgentSubagentSnapshot[] | undefined,
  b: AgentSubagentSnapshot[] | undefined
): boolean {
  if (!subagentsCanCross(a, b)) {
    return legacyAgentSubagentsEqual(a, b)
  }
  const answer = dispatchAgentStatus('agentSubagentsEqual', { a, b }, 'subagents')
  return answer === null ? legacyAgentSubagentsEqual(a, b) : (answer as boolean)
}
