import { networkInterfaces } from 'node:os'
import { isTailscaleEndpoint } from '../../shared/remote-runtime-tailscale-hint'
import {
  isVirtualBridgeInterface,
  selectAutoAdvertisedPairingAddress
} from '../../shared/pairing-address-auto-selection'
import { isTailnetIPv4Address } from '../rust-tailnet-address'

export type NetworkInterface = {
  name: string
  address: string
}

// Why: fe80::/10 link-local addresses need a zone index the phone cannot dial.
const IPV6_LINK_LOCAL_RE = /^fe[89ab]/i

// Why: pushes container/VM bridges below every real address so they stay in the picker list yet are
// never the auto-advertised default. Larger than the widest real rank (IPv6 = 2) so no bridge outranks
// a genuine interface.
const VIRTUAL_BRIDGE_RANK_PENALTY = 3

export type PairingInterfaceDeps = {
  readInterfaces?: typeof networkInterfaces
  isTailnetIPv4?: (address: string) => boolean
}

/**
 * Non-internal addresses a mobile device could dial, best candidate first:
 * tailnet overlay addresses (reachable off-LAN), then LAN IPv4, then global
 * IPv6 — so IPv6-only hosts still get an advertisable pairing address (#9130).
 * Container/VM bridges sort below all of them and stay in the list so they
 * remain explicitly pickable; the automatic default skips them entirely.
 * `resolvePairingEndpoint` brackets IPv6 literals for the ws:// URL.
 */
export function listPairingNetworkInterfaces(deps: PairingInterfaceDeps = {}): NetworkInterface[] {
  const readInterfaces = deps.readInterfaces ?? networkInterfaces
  const isTailnetIPv4 = deps.isTailnetIPv4 ?? isTailnetIPv4Address
  const candidates: { entry: NetworkInterface; rank: number }[] = []
  for (const [name, addrs] of Object.entries(readInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal) {
        continue
      }
      const bridgePenalty = isVirtualBridgeInterface(name) ? VIRTUAL_BRIDGE_RANK_PENALTY : 0
      if (addr.family === 'IPv4') {
        candidates.push({
          entry: { name, address: addr.address },
          rank: (isTailnetIPv4Safely(isTailnetIPv4, addr.address) ? 0 : 1) + bridgePenalty
        })
      } else if (addr.family === 'IPv6' && !IPV6_LINK_LOCAL_RE.test(addr.address)) {
        candidates.push({
          entry: { name, address: addr.address },
          // Why: the ws://[…] wrapper lets the shared endpoint classifier see a
          // bare IPv6 literal as a host (a raw `fd7a:…` string parses as a URL scheme).
          rank: (isTailscaleEndpoint(`ws://[${addr.address}]`) ? 0 : 2) + bridgePenalty
        })
      }
    }
  }
  // Stable sort: enumeration order breaks ties within a rank.
  return candidates.sort((a, b) => a.rank - b.rank).map((candidate) => candidate.entry)
}

// Why: null when every enumerated interface is a host-local bridge, so a docker0-only host
// advertises no direct address instead of one the phone provably cannot reach. Relay pairs without it.
export function getDefaultPairingAddress(deps: PairingInterfaceDeps = {}): string | null {
  const isTailnetIPv4 = deps.isTailnetIPv4 ?? isTailnetIPv4Address
  return (
    selectAutoAdvertisedPairingAddress(listPairingNetworkInterfaces(deps), (address) =>
      isTailnetIPv4Safely(isTailnetIPv4, address)
    ) ?? null
  )
}

// Why: the classifier needs the native addon; when it can't load, pairing must
// still enumerate addresses — an unknown tailnet status only costs sort order.
function isTailnetIPv4Safely(classify: (address: string) => boolean, address: string): boolean {
  try {
    return classify(address)
  } catch {
    return false
  }
}
