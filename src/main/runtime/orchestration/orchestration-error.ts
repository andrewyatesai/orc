export class OrchestrationError extends Error {
  readonly code: string
  readonly data?: unknown

  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.name = 'OrchestrationError'
    this.code = code
    this.data = data
  }
}

type OrchestrationErrorEnvelope = {
  _orcaOrchestrationError: true
  code: string
  message: string
  data?: unknown
}

/**
 * The Rust store serializes a coded failure into the napi `Error.message` as a
 * JSON envelope (see orchestration/error.rs); restore it so callers branch on
 * `.code`. Scoped to the v10 capability methods — every other store method
 * keeps its verbatim message, so a non-envelope error passes through untouched.
 */
export function restoreCodedError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(error.message)
  } catch {
    return error
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as OrchestrationErrorEnvelope)._orcaOrchestrationError !== true
  ) {
    return error
  }
  const envelope = parsed as OrchestrationErrorEnvelope
  return new OrchestrationError(envelope.code, envelope.message, envelope.data ?? undefined)
}
