// Main-process tailnet-address classifier, driven by the Rust orca-core core via
// napi (the shared TS impl was deleted). One source of truth with the
// parity-proven Rust port. The vector input is a bare string, so we stringify
// the address directly (matching the Rust dispatch's `input.as_str()`).
import { dispatchToRustCore } from './rust-core-dispatch'

export function isTailnetIPv4Address(address: string): boolean {
  return dispatchToRustCore('tailnet-address', 'isTailnetIPv4Address', address, {
    root: 'address'
  }) as boolean
}
