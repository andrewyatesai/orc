import type { ConnectionState, HostProfile } from './types'

// Why (#11642): the Home screen paired dozens of hosts; auto-connecting all of them fanned out N sockets on cold start.
export const HOME_AUTO_CONNECT_LIMIT = 3

// Most-recently-connected credentialed hosts, capped so a large host list can't flood the network on mount.
export function selectHomeAutoConnectHostIds(
  hosts: readonly HostProfile[],
  limit = HOME_AUTO_CONNECT_LIMIT
): string[] {
  return [...hosts]
    .filter((host) => host.deviceToken.length > 0 && host.publicKeyB64.length > 0)
    .sort(
      (left, right) => right.lastConnected - left.lastConnected || left.id.localeCompare(right.id)
    )
    .slice(0, Math.max(0, limit))
    .map((host) => host.id)
}

// Hosts outside the startup subset read 'disconnected', not a perpetual 'connecting' spinner.
export function resolveHomeHostConnectionState(
  hostId: string,
  state: ConnectionState | undefined,
  autoConnectHostIds: readonly string[]
): ConnectionState {
  return state ?? (autoConnectHostIds.includes(hostId) ? 'connecting' : 'disconnected')
}
