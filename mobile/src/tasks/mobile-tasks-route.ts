import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'
import type { TaskProvider } from './mobile-task-providers'

/** Identities stay raw — the navigator owns the params, so pre-encoding a host
 *  id would reach the Tasks screen still escaped. */
export function mobileTasksRouteTarget(
  hostId: string,
  provider?: TaskProvider
): HostStackRouteTarget {
  return {
    name: '[hostId]/tasks',
    params: provider ? { hostId, taskSource: provider } : { hostId }
  }
}
