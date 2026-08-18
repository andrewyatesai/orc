// TS dispatch for the mcp-env parity module: maps the shared vector function
// names to the real `src/shared/mcp-config.ts` exports so the harness compares
// the live TS reference against the Rust `orca-text::mcp_env` port.

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
