// The gauntlet's exit contract — what a status set means to the shell.
//
// WHY a dedicated code instead of failing every SKIP: a SKIP is honest when a
// developer lacks a local toolchain (no napi addon, no Trust `ay`/`trustc`), so
// hard-failing it would punish an environment rather than catch a regression.
// But exit 0 means "proved", and a gate that never ran proved nothing — so a run
// whose selected gates ALL skipped exits NOTHING_PROVEN, a run that skipped only
// some axes exits REVIEW (incomplete), and 0 is reserved for a run where every
// selected gate actually produced a green verdict. Single-gate probes obey the
// same rule: `gauntlet conformance` on a machine with no addon used to exit 0.
//
// Extracted from gauntlet.mjs so the decision is unit-testable on its own and so
// that file stays under its max-lines cap.

export const EXIT = { pass: 0, fail: 1, review: 2, nothingProven: 3 }

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** @returns {{ code: number, line: string }} exit code + the one-line verdict to print. */
export function gauntletExit(statuses) {
  if (statuses.length === 0) {
    // An empty selection is the classic silently-green gate: nothing ran.
    return { code: EXIT.nothingProven, line: '0 gates selected — NOTHING PROVEN' }
  }
  const count = (s) => statuses.filter((x) => x === s).length
  const passed = count('PASS')
  const failed = count('FAIL')
  const review = count('REVIEW')
  const skipped = count('SKIP')
  const head = `${plural(statuses.length, 'gate')} — ${[
    `${passed} passed`,
    failed ? `${failed} FAILED` : null,
    review ? `${review} REVIEW` : null,
    skipped ? `${skipped} skipped (proved nothing)` : null
  ]
    .filter(Boolean)
    .join(', ')}`
  const verdict = (code, why) => ({ code, line: `${head} → exit ${code}: ${why}` })
  if (failed) {
    return verdict(EXIT.fail, 'FAIL')
  }
  if (review) {
    return verdict(EXIT.review, 'REVIEW — triage before calling this green')
  }
  if (skipped && passed === 0) {
    return verdict(
      EXIT.nothingProven,
      'NOTHING PROVEN — every selected gate skipped; this is NOT a pass'
    )
  }
  if (skipped) {
    return verdict(EXIT.review, `INCOMPLETE — ${skipped} axis/axes never ran; not green`)
  }
  return verdict(EXIT.pass, 'every selected gate proved green')
}
