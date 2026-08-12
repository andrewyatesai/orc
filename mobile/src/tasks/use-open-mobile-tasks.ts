import { useCallback } from 'react'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import { mobileTasksRouteTarget } from './mobile-tasks-route'
import type { TaskProvider } from './mobile-task-providers'

// Why: a cold deep push straight to /h/[hostId]/tasks resolves to the host index
// without its dynamic id and lands on a blank host screen; route through the
// host-stack navigator so Tasks only replaces once the HostStack is committed.
export function useOpenMobileTasks(): (hostId: string, provider?: TaskProvider) => void {
  const openHostStackRoute = useOpenHostStackRoute()

  return useCallback(
    (hostId, provider) => {
      openHostStackRoute(hostId, mobileTasksRouteTarget(hostId, provider))
    },
    [openHostStackRoute]
  )
}
