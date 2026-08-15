// TS dispatch for the synthetic-agent-title parity module. The shared TS impl was
// DELETED (`src/shared/synthetic-agent-title.ts` keeps only the profile type and
// the SYNTHETIC_AGENT_TITLE_PROFILES table, which agent-title-owner.ts and
// agent-row-conversation-name.ts iterate in order — the Rust orca-core
// `synthetic_agent_title` port is the sole implementation, reached from main, the
// renderer and src/shared alike through
// src/shared/synthetic-agent-title-resolution.ts on the orca-dispatch seam), so
// this adapter drives the SAME wasm: the vectors' recorded goldens now pin the
// production surface, and the harness's TS-vs-Rust diff degenerates to
// wasm-vs-binary (drift between the two Rust entry points would still surface).
//
// The shim answers a payload the codec refuses — a lone surrogate in a custom
// agent name, an absent `state` — from its local body instead of dispatching;
// every vector here is in-contract, so that guard is out of this module's scope
// and is pinned by synthetic-agent-title-resolution.test.ts instead.
import { gitWasmOracle } from './orca-git-wasm-oracle'

export function dispatch(fn: string, input: unknown): unknown {
  return JSON.parse(
    gitWasmOracle().orcaDispatch('synthetic-agent-title', fn, JSON.stringify(input ?? null))
  )
}
