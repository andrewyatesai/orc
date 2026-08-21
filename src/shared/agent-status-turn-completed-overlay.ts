import { normalizeTurnCompletedAtField } from './agent-status-field-normalization'
import type { ParsedAgentStatusPayload } from './agent-status-types'

/** The shipped core predates `turnCompletedAt`, so serde drops it at the seam;
 *  the TS-normalized value from the original input rides on the core's answer
 *  until the core (and its napi/wasm blobs) carry the field. */
export function overlayTurnCompletedAt(
  shaped: ParsedAgentStatusPayload,
  original: unknown
): ParsedAgentStatusPayload {
  if (typeof original !== 'object' || original === null) {
    return shaped
  }
  const normalized = normalizeTurnCompletedAtField(
    (original as Record<string, unknown>).turnCompletedAt,
    shaped.state
  )
  if (normalized !== undefined) {
    shaped.turnCompletedAt = normalized
  }
  return shaped
}
