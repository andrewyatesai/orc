// TS dispatch for the commit-message-host-key parity module. The shared TS impl
// was reduced to its constants (the Rust commit_message_host_key core is the sole
// impl — main drives it via napi, the renderer via wasm), so this adapter drives
// the SAME wasm: the vectors' recorded goldens now pin that surface, and the
// harness's TS-vs-Rust diff degenerates to wasm-vs-binary.
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(
    gitWasmOracle().orcaDispatch('commit-message-host-key', fn, JSON.stringify(input ?? null))
  )
}
