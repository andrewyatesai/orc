// Why: this file mirrors the desktop evaluator, now
// src/shared/protocol-compat-verdict.ts (a shim over the Rust
// `orca_core::protocol_compat` port; src/shared/protocol-compat.ts keeps only the
// types). Metro can't resolve out of mobile/, so the pure function is duplicated
// here. Keep the two in sync — when the evaluator's logic changes, update both
// and the shared parity vectors (tools/parity/vectors/protocol-compat.json),
// which are what pin this copy to the same behaviour.
import { MIN_COMPATIBLE_DESKTOP_VERSION, MOBILE_PROTOCOL_VERSION } from './protocol-version'

export type CompatVerdict =
  | { kind: 'ok' }
  | {
      kind: 'blocked'
      reason: 'mobile-too-old' | 'desktop-too-old'
      desktopVersion: number
      requiredMobileVersion?: number
      requiredDesktopVersion?: number
    }

export function evaluateCompat(input: {
  desktopProtocolVersion: number | undefined
  desktopMinCompatibleMobileVersion: number | undefined
}): CompatVerdict {
  const desktopVersion = input.desktopProtocolVersion ?? 0
  const requiredMobile = input.desktopMinCompatibleMobileVersion ?? 0

  if (MOBILE_PROTOCOL_VERSION < requiredMobile) {
    return {
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion,
      requiredMobileVersion: requiredMobile
    }
  }
  if (desktopVersion < MIN_COMPATIBLE_DESKTOP_VERSION) {
    return {
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion,
      requiredDesktopVersion: MIN_COMPATIBLE_DESKTOP_VERSION
    }
  }
  return { kind: 'ok' }
}
