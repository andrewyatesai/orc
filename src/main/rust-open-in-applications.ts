// Main-process open-in-applications sanitizer, driven by the Rust orca-config
// core via napi (the shared TS body was deleted). persistence.ts sanitizes the
// persisted field on load (seedDefaults) and on every settings update; the
// renderer drives the same op through wasm.
import { dispatchToRustCore } from './rust-core-dispatch'
import type { NormalizeOpenInApplicationsOptions } from '../shared/open-in-applications'
import type { OpenInApplication } from '../shared/types'

export function normalizeOpenInApplications(
  value: unknown,
  options: NormalizeOpenInApplicationsOptions = {}
): OpenInApplication[] {
  // Reify the optional id generator as a plain-JSON pool the Rust closure pops
  // in sequence (main call sites never pass createId, so this stays undefined).
  const createIds =
    Array.isArray(value) && options.createId ? value.map(() => options.createId!()) : undefined
  // Why 'omit': an absent `createIds` IS the no-generator case the Rust side
  // reads as None — the key is deliberately left off, not lost.
  return dispatchToRustCore(
    'open-in-applications',
    'normalizeOpenInApplications',
    { value, seedDefaults: options.seedDefaults ?? false, createIds },
    { undefinedProperties: 'omit' }
  ) as OpenInApplication[]
}
