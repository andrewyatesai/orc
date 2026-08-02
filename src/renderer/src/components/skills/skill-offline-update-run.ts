import { useSyncExternalStore } from 'react'
import { installBundledSkillsOffline } from '@/lib/bundled-skill-offline-install'

/** Names the bundled installer is writing, and the ones it could not converge. */
export type OfflineSkillUpdateRun = {
  names: string[]
  running: boolean
  failedNames: string[]
}

const IDLE_RUN: OfflineSkillUpdateRun = { names: [], running: false, failedNames: [] }

// Why: kept outside React for the same reason as the npx run — the dialog renders
// it, but closing the dialog must not abandon a write already in flight.
let run: OfflineSkillUpdateRun = IDLE_RUN
const listeners = new Set<() => void>()

function setRun(next: OfflineSkillUpdateRun): void {
  run = next
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeOfflineSkillUpdateRun(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getOfflineSkillUpdateRun(): OfflineSkillUpdateRun {
  return run
}

export function useOfflineSkillUpdateRun(): OfflineSkillUpdateRun {
  return useSyncExternalStore(
    subscribeOfflineSkillUpdateRun,
    getOfflineSkillUpdateRun,
    getOfflineSkillUpdateRun
  )
}

/**
 * Converge names this build ships bytes for, straight from the app bundle.
 *
 * One call per name on purpose: the installer summarizes a batch down to the single
 * outcome that still needs a human, which would leave the other rows unable to say
 * whether they landed. Each name reports its own result to the user.
 */
export async function startOfflineSkillUpdate(names: readonly string[]): Promise<void> {
  if (names.length === 0 || run.running) {
    return
  }
  const targets = [...names]
  setRun({ names: targets, running: true, failedNames: [] })
  const failedNames: string[] = []
  for (const name of targets) {
    if (!(await installBundledSkillsOffline({ names: [name], skillLabel: name }))) {
      failedNames.push(name)
    }
  }
  setRun({ names: targets, running: false, failedNames })
}

/** Retire a settled run so its rows do not follow the dialog into its next open. */
export function acknowledgeOfflineSkillUpdateRun(): void {
  if (!run.running && run.names.length > 0) {
    setRun(IDLE_RUN)
  }
}

/** @internal - tests need a clean module between cases. */
export function _resetOfflineSkillUpdateRun(): void {
  run = IDLE_RUN
  listeners.clear()
}
