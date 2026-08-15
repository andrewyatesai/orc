// Tree-agnostic push-target shape assertion, for the `src/shared`-reachable
// callers that run on MORE than one surface and so cannot import either tree's
// binding: main's IPC handlers (napi) and the SSH relay's git handler (wasm via
// initSync) both reach `orca_core::git_push_target` through `orca-dispatch-seam`.
// `src/main/git/*` keeps its own napi shim (`rust-push-target-validation.ts`,
// typed `validateGitPushTargetRules` export) — same Rust rules, main-only seam.
//
// Only the `unknown`→typed guards live in JS: they own the JS-boundary
// "Invalid PR push target …" messages the Rust value-rule validator never
// produces, and their ORDER is load-bearing (remoteUrl's type guard runs AFTER
// the name/branch value rules, so a target that is both name-invalid and carries
// a non-string URL reports the name).
//
// PRE-READY CONTRACT — `parity`. An `asserts` function has exactly two
// observable states, throw and return, and both are real answers: there is no
// spare state for a not-ready signal, and this is the anti-traversal gate on a
// value that is replayed into `git push`, so a fail-open OR a fail-closed guess
// is a defect. The fallback therefore rebuilds the deleted twin's body from the
// rule constants it still exports, and is the answer for every input.
import { DispatchPayloadError } from './dispatch-payload-codec'
import {
  GITHUB_CLONE_URL,
  GITHUB_SSH_URL,
  MAX_GIT_REMOTE_NAME_LENGTH,
  SAFE_GIT_REMOTE_NAME_SEGMENT
} from './git-push-target-validation'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import type { GitPushTarget } from './types'

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid PR push target ${name}.`)
  }
}

function isSafeRemoteName(remoteName: string): boolean {
  if (remoteName.length === 0 || remoteName.length > MAX_GIT_REMOTE_NAME_LENGTH) {
    return false
  }
  return remoteName
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        SAFE_GIT_REMOTE_NAME_SEGMENT.test(segment)
    )
}

/** The deleted twin's value rules, rebuilt from the constants it still exports —
 *  the not-ready / un-encodable answer, identical to the core's for every input. */
function localRuleError(
  remoteName: string,
  branchName: string,
  remoteUrl: string | null
): string | null {
  if (!isSafeRemoteName(remoteName)) {
    return `Invalid git remote name: ${remoteName}`
  }
  if (!branchName || branchName.startsWith('-')) {
    return `Invalid git branch name: ${branchName}`
  }
  if (remoteUrl !== null && !(GITHUB_CLONE_URL.test(remoteUrl) || GITHUB_SSH_URL.test(remoteUrl))) {
    return 'Invalid PR push target remote URL.'
  }
  return null
}

function ruleError(
  remoteName: string,
  branchName: string,
  remoteUrl: string | null
): string | null {
  try {
    // Only the three validated fields cross — never the caller's whole object.
    // A lone surrogate on an UNREAD extra property would otherwise fail the
    // encode and flip an accept into a reject naming a field the twin never read.
    const answer = tryOrcaDispatch(
      'git-push-target',
      'assertGitPushTargetShape',
      { remoteName, branchName, remoteUrl },
      { root: 'pushTarget' }
    )
    if (answer === null) {
      return localRuleError(remoteName, branchName, remoteUrl)
    }
    const verdict = answer as { ok: boolean; error?: string }
    return verdict.ok ? null : (verdict.error ?? 'Invalid PR push target.')
  } catch (error) {
    // Why the catch: both callers validate a target off the wire (Electron
    // structured clone, relay JSON), so a field can carry a lone UTF-16
    // surrogate — the codec refuses to encode it and the twin answered it
    // without crossing, so the fallback is that same answer. It matters in BOTH
    // directions here: `\ud800` in remoteName is rejected by the segment
    // allowlist, but in branchName the twin ACCEPTED it (git's check-ref-format
    // is the next gate) and a codec throw would reject a target the user owns.
    // Only the encode rejection is caught; a DispatchCoreError still propagates.
    if (error instanceof DispatchPayloadError) {
      return localRuleError(remoteName, branchName, remoteUrl)
    }
    throw error
  }
}

/**
 * Validate a persisted/wire push target's shape. Throws with the same message
 * and in the same order as the deleted `src/shared/git-push-target-validation.ts`
 * implementation; the value rules run in `orca_core::git_push_target`.
 */
export function assertGitPushTargetShape(target: unknown): asserts target is GitPushTarget {
  if (typeof target !== 'object' || target === null) {
    throw new Error('Invalid PR push target.')
  }
  const candidate = target as Record<string, unknown>
  assertString(candidate.remoteName, 'remote name')
  assertString(candidate.branchName, 'branch name')

  const urlPresent = candidate.remoteUrl !== undefined
  const urlIsString = typeof candidate.remoteUrl === 'string'
  // A present-but-non-string URL is withheld from the value rules so its type
  // guard still fires after them, preserving the twin's message ordering.
  const error = ruleError(
    candidate.remoteName,
    candidate.branchName,
    urlPresent && urlIsString ? (candidate.remoteUrl as string) : null
  )
  if (error) {
    throw new Error(error)
  }
  if (urlPresent && !urlIsString) {
    throw new Error('Invalid PR push target remote URL.')
  }
}
