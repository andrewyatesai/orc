// Main-process hosted-review ref normalizers, driven by the Rust
// hosted-review-refs core via napi (the shared TS impl was gutted). One source
// of truth with the parity-proven Rust port.
import { dispatchToRustCore } from './rust-core-dispatch'

// Payload is a bare ref string, so the codec's default (reject anything JSON
// would mangle) is exactly right here — nothing optional crosses.
function dispatch(fn: string, input: unknown): unknown {
  return dispatchToRustCore('hosted-review-refs', fn, input)
}

export function normalizeHostedReviewHeadRef(ref: string): string {
  return dispatch('normalizeHostedReviewHeadRef', ref) as string
}

export function normalizeHostedReviewBaseRef(ref: string): string {
  return dispatch('normalizeHostedReviewBaseRef', ref) as string
}
