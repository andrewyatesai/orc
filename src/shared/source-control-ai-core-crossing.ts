// How `source-control-ai.ts` crosses the dispatch seam: the one
// dispatch call, and the two ways an answer comes back.
//
// The distinction this file exists to keep straight is NOT_CROSSED vs `null`.
// `tryOrcaDispatch` answers `null` for an unbound seam, and three of the module's
// exports answer `Value::Null` to mean TS `undefined` — so a shim that read the
// seam's `null` directly could not tell "the core did not run" from "there is no
// choice recorded". NOT_CROSSED carries the first, and only the first, so the
// three optional exports can safely read `null` as `undefined`.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { isOrcaDispatchReady, tryOrcaDispatch } from './orca-dispatch-seam'
import {
  coreRepoMember,
  coreSettingsSlice,
  UNPROJECTABLE,
  type Unprojectable
} from './source-control-ai-core-payload'

/** The seam did not answer: unbound, or a payload it refused to encode. */
export const NOT_CROSSED = Symbol('source-control-ai: the Rust core did not answer')
export type NotCrossed = typeof NOT_CROSSED

/**
 * Dispatch to the module's arm.
 *
 * `undefinedProperties: 'omit'` is mandatory, not tidy: this module's own output
 * is the next call's input and it carries own keys whose value is `undefined`
 * (`modelOverridesByOperation`), so 'reject' would fail the encode on the common
 * path. The twin folded own-undefined and absent together everywhere it tested
 * `hasOwnProperty`, which is what makes it answer-preserving — see the residual
 * list in `source-control-ai.ts`.
 */
export function cross(fn: string, input: unknown, root: string): unknown | NotCrossed {
  if (!isOrcaDispatchReady()) {
    return NOT_CROSSED
  }
  try {
    // The module key stays a string LITERAL: report-rust-orphan-ports.mjs can only
    // attribute a dispatch site whose key is a literal node, and hoisting it to a
    // const listed this module as an ORPHAN PORT with the cutover already done.
    return tryOrcaDispatch('source-control-ai', fn, input, { root, undefinedProperties: 'omit' })
  } catch (error) {
    // Why the catch: every argument here is read off persisted settings or off
    // the relay wire, so it can carry a lone UTF-16 surrogate the codec refuses.
    // The twin answered those. A DispatchCoreError still propagates — an unknown
    // function is a bug, not a degraded input.
    if (error instanceof DispatchPayloadError) {
      return NOT_CROSSED
    }
    throw error
  }
}

/** The eleven exports whose answer is never `null`. */
export function crossed<T>(answer: unknown | NotCrossed, fallback: () => T): T {
  return answer === NOT_CROSSED ? fallback() : (answer as T)
}

/** The three that can answer TS `undefined`, which the arm spells `Value::Null`. */
export function crossedOptional<T>(
  answer: unknown | NotCrossed,
  fallback: () => T | undefined
): T | undefined {
  if (answer === NOT_CROSSED) {
    return fallback()
  }
  return answer === null ? undefined : (answer as T)
}

/** `{settings, repo}` narrowed to the members the core reads, or UNPROJECTABLE. */
export function settingsAndRepo(
  settings: unknown,
  repo: unknown
): Record<string, unknown> | Unprojectable {
  const slice = coreSettingsSlice(settings)
  if (slice === UNPROJECTABLE) {
    return UNPROJECTABLE
  }
  const payload: Record<string, unknown> = {}
  if (slice !== null) {
    payload.settings = slice
  }
  const overrides = coreRepoMember(repo)
  if (overrides !== undefined) {
    payload.repo = { sourceControlAi: overrides }
  }
  return payload
}

/** Every key the core reads as an object key or id must really be a string; it
 *  takes them with `as_str`, where the twin indexed with the raw value. */
export function areStrings(...keys: unknown[]): boolean {
  return keys.every((key) => typeof key === 'string')
}
