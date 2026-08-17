import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'

/**
 * Retryable teardown of a runtime's hidden (runtime-owned) SSH target.
 *
 * Only clears the target id when removal actually succeeds, so an interrupted
 * teardown stays retryable instead of orphaning the hidden target. Re-reads the
 * record after the async removal so a stale concurrent failure can't regress a
 * cleanup another call already completed.
 */
export async function removeEphemeralVmRuntimeSshTarget(args: {
  userDataPath: string
  runtime: EphemeralVmRuntimeRecord
  removeTarget: (targetId: string) => Promise<void>
}): Promise<EphemeralVmRuntimeRecord> {
  const current = getCurrentRuntime(args.userDataPath, args.runtime)
  if (!current.sshTargetId) {
    return finishCompletedCleanup(args.userDataPath, current)
  }
  try {
    await args.removeTarget(current.sshTargetId)
  } catch {
    const latest = getCurrentRuntime(args.userDataPath, current)
    if (!latest.sshTargetId) {
      return finishCompletedCleanup(args.userDataPath, latest)
    }
    return updateEphemeralVmRuntimeStatus(args.userDataPath, latest.id, {
      status: 'cleanup_failed',
      cleanupLastError: 'Failed to remove the hidden SSH target.'
    })
  }
  const latest = getCurrentRuntime(args.userDataPath, current)
  const status = latest.cleanupStatus === 'succeeded' ? 'cleaned' : latest.status
  return updateEphemeralVmRuntimeStatus(args.userDataPath, latest.id, {
    status,
    ...(status === 'cleaned' ? { cleanupLastError: null } : {}),
    connectionMode: null,
    sshTargetId: null
  })
}

function getCurrentRuntime(
  userDataPath: string,
  fallback: EphemeralVmRuntimeRecord
): EphemeralVmRuntimeRecord {
  return listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === fallback.id) ?? fallback
}

// A completed provider cleanup whose target id is already gone still needs its
// terminal 'cleaned' status so the row stops showing as retryable.
function finishCompletedCleanup(
  userDataPath: string,
  runtime: EphemeralVmRuntimeRecord
): EphemeralVmRuntimeRecord {
  if (runtime.cleanupStatus !== 'succeeded' || runtime.status === 'cleaned') {
    return runtime
  }
  return updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
    status: 'cleaned',
    cleanupLastError: null,
    connectionMode: null,
    sshTargetId: null
  })
}
