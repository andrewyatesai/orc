// Guards initial SSH port-snapshot hydration against a fresher push that lands
// mid-fetch: a live onPortForwardsChanged/onDetectedPortsChanged must win over a
// stale listPortForwards/listDetectedPorts snapshot resolved after it (#11713).

type PendingPortHydration = {
  receivedForwardPush: boolean
  receivedDetectedPush: boolean
}

export type SshPortHydrationTicket = {
  shouldApplyForwards: () => boolean
  shouldApplyDetected: () => boolean
  finish: () => void
}

export type SshPortHydrationBarrier = {
  begin: (targetId: string) => SshPortHydrationTicket
  noteForwardPush: (targetId: string) => void
  noteDetectedPush: (targetId: string) => void
}

export function createSshPortHydrationBarrier(): SshPortHydrationBarrier {
  const pendingByTargetId = new Map<string, PendingPortHydration>()

  return {
    begin(targetId) {
      const pending: PendingPortHydration = {
        receivedForwardPush: false,
        receivedDetectedPush: false
      }
      pendingByTargetId.set(targetId, pending)
      return {
        shouldApplyForwards: () => !pending.receivedForwardPush,
        shouldApplyDetected: () => !pending.receivedDetectedPush,
        finish: () => {
          // Identity check: a re-entrant hydration may have replaced this entry.
          if (pendingByTargetId.get(targetId) === pending) {
            pendingByTargetId.delete(targetId)
          }
        }
      }
    },
    noteForwardPush(targetId) {
      const pending = pendingByTargetId.get(targetId)
      if (pending) {
        pending.receivedForwardPush = true
      }
    },
    noteDetectedPush(targetId) {
      const pending = pendingByTargetId.get(targetId)
      if (pending) {
        pending.receivedDetectedPush = true
      }
    }
  }
}
