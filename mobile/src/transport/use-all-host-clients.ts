import { useEffect, useMemo, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ConnectionState } from './types'
import { useRpcClientContext } from './client-context'

type UseAllHostClientsOptions = {
  // Subset of hostIds that may open a socket on mount; the rest stay tracked-but-disconnected (#11642).
  autoConnectHostIds?: readonly string[]
}

// Why: refcounting prevents a double-open when a host-detail screen shares one of these hosts.
export function useAllHostClients(hostIds: string[], options?: UseAllHostClientsOptions) {
  const ctx = useRpcClientContext()
  // Why (#11642): bound the auto-connect fanout — acquire only this subset, but still track every host's state for the list.
  const autoConnectHostIds = options?.autoConnectHostIds ?? hostIds
  // Stable key so we don't tear down on every render of the arrays.
  const key = useMemo(
    () => `${[...hostIds].sort().join(',')}|${[...autoConnectHostIds].sort().join(',')}`,
    [hostIds, autoConnectHostIds]
  )
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (hostIds.length === 0) {
      return
    }
    const trackedIds = new Set(hostIds)
    const acquired = [...new Set(autoConnectHostIds)].filter((id) => trackedIds.has(id))
    for (const id of acquired) {
      ctx.acquire(id)
    }
    const unsubs: Array<() => void> = []
    for (const id of hostIds) {
      unsubs.push(ctx.subscribeHostState(id, () => setTick((n) => n + 1)))
    }
    unsubs.push(ctx.subscribeAllHosts(() => setTick((n) => n + 1)))
    return () => {
      for (const u of unsubs) {
        u()
      }
      for (const id of acquired) {
        ctx.release(id)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return useMemo(() => {
    const out: Array<{
      hostId: string
      client: RpcClient
      state: ConnectionState
      path: MobileConnectionPath
      pendingPath: MobileConnectionPath | null
    }> = []
    for (const id of hostIds) {
      const all = ctx.getAllClients().find((entry) => entry.hostId === id)
      if (all) {
        out.push({
          hostId: id,
          client: all.client,
          state: ctx.getState(id),
          path: ctx.getActivePath(id),
          pendingPath: ctx.getPendingPath(id)
        })
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])
}
