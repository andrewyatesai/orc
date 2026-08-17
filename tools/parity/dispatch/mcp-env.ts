// TS dispatch for the mcp-env parity module. It drives `src/shared/mcp-config.ts`
// — which is NOT the live path and has not been since the `mcp` cutover moved
// the renderer onto the git-wasm shim. Calling it "the live TS reference", as
// this comment used to, was wrong.
//
// It is kept on purpose: an independent TS implementation is what makes this
// leg a real TS-vs-Rust differential instead of the wasm-vs-binary
// self-comparison every cut-over module degenerates to. See the header on
// `src/shared/mcp-server-inspection.ts`.

import { maskMcpEnv } from '../../../src/shared/mcp-config'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    // `undefined` has no JSON image, so the dropped-env answer (non-object input,
    // or an env that blew an inspection bound) is reported as null on both legs.
    case 'maskMcpEnv':
      return maskMcpEnv(input) ?? null
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
