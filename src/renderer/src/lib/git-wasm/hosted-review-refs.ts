// Renderer hosted-review ref normalizers, driven by the Rust hosted-review-refs
// core in the orca-git wasm module (the shared TS impl was gutted). Consumers do
// string ops (.split/.length/.toLowerCase) on the result, so a wasm-load FAILURE
// passes the input string through unchanged rather than returning null, which
// would throw at those callsites.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'

// Payload is a bare ref string, so the codec's default applies unrelaxed.
function op(fn: string, input: unknown): string | null {
  if (!isGitWasmReady()) {return null}
  return dispatchToWasmCore('hosted-review-refs', fn, input, { root: 'ref' }) as string
}

export function normalizeHostedReviewHeadRef(ref: string): string {
  return op('normalizeHostedReviewHeadRef', ref) ?? (typeof ref === 'string' ? ref : '')
}

export function normalizeHostedReviewBaseRef(ref: string): string {
  return op('normalizeHostedReviewBaseRef', ref) ?? (typeof ref === 'string' ? ref : '')
}
