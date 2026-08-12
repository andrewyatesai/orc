import { describe, expect, it } from 'vitest'
import { runtimePairingReachForAddress } from './runtime-pairing-reach-intent'

const LOOPBACK = '127.0.0.1'

// Why: #12405 — the renderer declares the reach so main can gate the one-way widen on intent, not address
// shape. Only the fixed "This computer (127.0.0.1)" option declines off-host reach.
describe('runtimePairingReachForAddress', () => {
  it('declares this-computer only for the loopback default option', () => {
    expect(runtimePairingReachForAddress(LOOPBACK, LOOPBACK)).toBe('this-computer')
  })

  it.each(['100.64.1.20', '192.168.1.24', 'host.tailnet.ts.net', '127.0.0.1:8443', 'localhost'])(
    'declares network reach for %s (LAN, Tailscale, or a loopback-looking custom tunnel front)',
    (address) => {
      expect(runtimePairingReachForAddress(address, LOOPBACK)).toBe('network')
    }
  )
})
