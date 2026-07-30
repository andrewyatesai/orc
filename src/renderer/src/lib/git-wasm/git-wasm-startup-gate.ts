import { startGitWasm } from './git-line-stats'

/** Boot gate for the orca-git wasm, awaited at the top of the startup
 *  hydration chain instead of before createRoot.
 *
 *  Why: React no longer waits for the wasm to mount (first paint of the empty
 *  shell needs none of it), but everything hydration runs — catalog merges
 *  (repo-icon/badge normalizers), persisted-UI task providers, and above all
 *  the agent-resume startup-plan builders that fire imperatively once
 *  workspaceSessionReady flips — must never hit a pre-ready null builder and
 *  stick on it. Awaiting here preserves the old gate's guarantee for every
 *  store-hydration and reconnectPersistedTerminals consumer while the compile
 *  overlaps the snapshot fetch and mount.
 *
 *  Failure backstop mirrors the old render gate: a genuine compile failure
 *  rejects fast and is swallowed (degraded null-fallback mode), the timeout is
 *  only an anti-hang backstop for a promise that never settles. */
export function awaitGitWasmReadyForStartupHydration(timeoutMs = 10_000): Promise<void> {
  return Promise.race([
    startGitWasm().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]).then(() => undefined)
}
