// The orca-git wasm core's lifecycle state, kept in its own dependency-free
// leaf so the loader (git-line-stats, which pulls in the 1.4 MB wasm asset), the
// startup gate, the failure reporter, and every shim can all read it without
// importing each other.

/** `pending` and `unavailable` both mean "no wasm right now", but only
 *  `unavailable` is terminal. `isGitWasmReady()` collapses the two, which is
 *  exactly why a load failure used to be indistinguishable from a slow compile
 *  and therefore invisible — ask `isGitWasmUnavailable()` when the difference
 *  matters (surfacing a degraded state, skipping a retry, choosing a fallback
 *  you intend to keep). */
export type GitWasmAvailability = 'pending' | 'ready' | 'unavailable'

let availability: GitWasmAvailability = 'pending'
let loadError: unknown = null
const listeners = new Set<() => void>()

function notifyAvailabilityListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function getGitWasmAvailability(): GitWasmAvailability {
  return availability
}

export function isGitWasmReady(): boolean {
  return availability === 'ready'
}

/** True only once the core has permanently failed — never true while it is
 *  still compiling, so a caller cannot mistake a slow boot for a dead core. */
export function isGitWasmUnavailable(): boolean {
  return availability === 'unavailable'
}

/** The rejection that killed the core, for diagnostics. `null` unless
 *  `isGitWasmUnavailable()`. */
export function getGitWasmLoadError(): unknown {
  return loadError
}

export function markGitWasmReady(): void {
  if (availability === 'ready') {
    return
  }
  availability = 'ready'
  loadError = null
  notifyAvailabilityListeners()
}

/** Terminal transition: the core will not become ready in this session. A
 *  `ready` core is never demoted (the test-only sync init can land first). */
export function markGitWasmUnavailable(error: unknown): void {
  if (availability !== 'pending') {
    return
  }
  availability = 'unavailable'
  loadError = error
  notifyAvailabilityListeners()
}

/** For `useSyncExternalStore`. Fires on every availability transition, so a
 *  surface can re-render for the failure edge and not just the ready edge. */
export function subscribeGitWasmAvailability(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function _resetGitWasmAvailabilityForTests(): void {
  availability = 'pending'
  loadError = null
  listeners.clear()
}
