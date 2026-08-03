// Panic containment for native engine calls, split out of headless-emulator.ts
// (line budget) now that six context verbs read through it.
//
// The rule it enforces: a Rust panic reaches JS as an exception (the addon wraps
// every export in catch_unwind), and an engine that panicked has untrustworthy
// state. So the FIRST failure poisons this emulator and every later call returns
// its caller's declared fallback instead of touching the engine again. The
// daemon and its other sessions keep running; the respawn/snapshot machinery
// recovers this one.
//
// `guarded` exists separately from `run` because the context verbs (search,
// extents, images, screen) need dispose and poison to answer the SAME degraded
// value: each of them feeds a caller that has to tell "nothing there" from
// "could not look", and two different silences would blur that.

export class HeadlessEngineGuard {
  private failed = false

  /** True until a native call has thrown. False means this emulator has
   *  degraded to scan-only state. */
  get healthy(): boolean {
    return !this.failed
  }

  /** Run one native call, poisoning on the first throw (one loud log). */
  run<T>(op: string, call: () => T, fallback: () => T): T {
    if (this.failed) {
      return fallback()
    }
    try {
      return call()
    } catch (error) {
      this.failed = true
      console.error(
        `[orca] aterm terminal engine ${op} failed — poisoning this session's emulator ` +
          '(scan-only state from here; other sessions unaffected):',
        error
      )
      return fallback()
    }
  }

  /** A read whose degraded answer is an explicit value, taken for a disposed
   *  emulator as well as a poisoned one. */
  guarded<T>(disposed: boolean, op: string, read: () => T, degraded: T): T {
    return disposed ? degraded : this.run(op, read, () => degraded)
  }
}
