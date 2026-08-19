import type { GitPushTarget } from '../../shared/types'
import { requireRustGitBinding } from '../daemon/rust-git-addon'

// Main-process push-target validation. The substantive path-traversal-safety rules
// (remote name / branch name / GitHub URL) run in the verified `orca_core` validator
// behind the napi boundary — the sole path (the addon is a required main-process
// dependency). Only the `unknown`→typed guards live here in JS — they own the
// JS-boundary "Invalid PR push target …" messages the Rust value-rule validator never
// produces. The pure TS validator is gone; the addon-less SSH relay and main's own IPC
// handlers reach the SAME Rust rules through src/shared/git-push-target-shape.ts on the
// orca-dispatch seam, which is also this shim's oracle in tests.

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid PR push target ${name}.`)
  }
}

/**
 * Validate a push target's shape using the native value-rule validator. Behaviour —
 * including exact error message and ordering — is identical to the seam shim
 * `src/shared/git-push-target-shape.ts`.
 */
export function assertGitPushTargetShapeNative(
  target: unknown
): asserts target is GitPushTarget {
  const binding = requireRustGitBinding()

  // Type-coercion guards, in the order the canonical TS validator applies them:
  // object, then remoteName/branchName strings. remoteUrl's type guard is
  // deliberately deferred below — the canonical validator runs it AFTER the
  // name/branch value rules, so preserving that ordering keeps error parity when
  // a target is both name-invalid and carries a non-string URL.
  if (typeof target !== 'object' || target === null) {
    throw new Error('Invalid PR push target.')
  }
  const candidate = target as Record<string, unknown>
  assertString(candidate.remoteName, 'remote name')
  assertString(candidate.branchName, 'branch name')

  const urlPresent = candidate.remoteUrl !== undefined
  const urlIsString = typeof candidate.remoteUrl === 'string'
  // Pass the URL to Rust only when it is a present string; a present-but-non-string
  // URL is left for the deferred type guard so its message fires in the right order.
  const error = binding.validateGitPushTargetRules(
    candidate.remoteName,
    candidate.branchName,
    urlPresent && urlIsString ? (candidate.remoteUrl as string) : null
  )
  if (error) {
    throw new Error(error)
  }
  // Name + branch (and a string URL) passed. The only remaining case is a
  // present non-string URL — the deferred guard, matching assertString's message.
  if (urlPresent && !urlIsString) {
    throw new Error('Invalid PR push target remote URL.')
  }
}
