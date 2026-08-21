// MCP env masking — the live TypeScript twin of the `mcp-env` parity module
// (rust/crates/orca-text/src/mcp_env.rs), which is NOT cut over.
//
// `summarizeMcpServer` used to live here too. It was the back half of the `mcp`
// module and now belongs to the Rust core (rust/crates/orca-config/src/mcp.rs),
// reached from the renderer through
// src/renderer/src/lib/git-wasm/mcp-config-content-inspection.ts.
import {
  isMcpConfigInspectionFieldWithinLimit,
  isMcpConfigInspectionNameWithinLimit,
  MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS
} from './mcp-config-inspection-limits'

const SENSITIVE_ENV_KEY_PATTERN =
  /(api[_-]?key|auth|bearer|cookie|credential|password|private[_-]?key|secret|session|token)/i
const SENSITIVE_ENV_VALUE_PATTERN =
  /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})/

/** The masked env, or `undefined` when the map is not an object or blew one of
 *  the inspection bounds — an over-bound env is refused whole, never truncated. */
export function maskMcpEnv(env: unknown): Record<string, string> | undefined {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return undefined
  }

  const masked: Record<string, string> = {}
  let fields = 0
  for (const key in env) {
    if (!Object.hasOwn(env, key)) {
      continue
    }
    fields += 1
    if (
      fields > MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS ||
      !isMcpConfigInspectionNameWithinLimit(key)
    ) {
      return undefined
    }
    const rawValue = (env as Record<string, unknown>)[key]
    const value = typeof rawValue === 'string' ? rawValue : String(rawValue)
    if (!isMcpConfigInspectionFieldWithinLimit(value)) {
      return undefined
    }
    masked[key] =
      SENSITIVE_ENV_KEY_PATTERN.test(key) || SENSITIVE_ENV_VALUE_PATTERN.test(value)
        ? '••••••••'
        : value
  }
  return masked
}
