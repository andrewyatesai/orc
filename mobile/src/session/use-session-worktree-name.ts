import { useRouter } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { hostRouteWithNotice } from '../host-route-notice'
import { useLiveWorktreeName } from './use-live-worktree-name'
import { useMissingWorktreeBounce } from './use-missing-worktree-bounce'

/** The live worktree title plus its safety net: once the host proves the workspace is gone
 *  (a stale Resume, notification, or cold deep link), the route bounces to the host index
 *  with a notice instead of stranding on a session screen whose every RPC fails. */
export function useSessionWorktreeName(args: {
  client: RpcClient | null
  connState: ConnectionState
  routeName?: string
  hostId: string
  worktreeId: string
}): string {
  const { client, connState, routeName, hostId, worktreeId } = args
  const router = useRouter()
  const { name, resolution } = useLiveWorktreeName({ client, connState, routeName, worktreeId })
  useMissingWorktreeBounce({
    hostId,
    worktreeId,
    resolution,
    bounce: (id) => router.replace(hostRouteWithNotice(id, 'worktree-missing'))
  })
  return name
}
