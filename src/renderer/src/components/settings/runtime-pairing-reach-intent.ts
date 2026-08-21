import type { RuntimePairingReach } from '../../../../shared/runtime-pairing-reach'

// Why: main gates the one-way, host-wide network widen on the reach the user declared, not on how the
// address happens to look. In this settings surface the reach IS the selection: the fixed "This computer
// (127.0.0.1)" option is the only off-host decline. A LAN/Tailscale pick, or a Custom loopback-with-port
// (`127.0.0.1:8443`) that fronts an SSH tunnel or reverse proxy, all differ from the loopback default and
// so declare network reach — the address string alone cannot tell those apart from "This computer only".
export function runtimePairingReachForAddress(
  address: string,
  loopbackAddress: string
): RuntimePairingReach {
  return address === loopbackAddress ? 'this-computer' : 'network'
}
