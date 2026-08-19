// MCP config inspection, driven by the Rust `mcp` core in the orca-git wasm
// (rust/crates/orca-config/src/mcp.rs). The shared TS twin is reduced to types
// and data — the candidate table, MCP_STARTER_CONFIG, and the directory-discovery
// helpers all still live in src/shared/mcp-config.ts.
//
// PRE-READY VALUE — the two input classes are decided separately, because the
// twin answered them differently:
//
//  * `content === null` (the file is absent) → PARITY. The deleted twin's first
//    statement returned the constant `{candidate, exists: false, status:
//    'missing', servers: []}` and read nothing else — not the candidate's
//    serversPath, not a limit, not the parser — so the fallback below IS the
//    ready answer for every input in this class, and the shim-pre-ready-contract
//    row observes that rather than asserting it. Four of the five call sites are
//    in this class, so the missing-config list and the SSH/unreachable-root
//    banners still render correctly before the wasm lands.
//
//  * `content` is a string → SENTINEL `null`. Case 3 in
//    docs/rust-migration/ported-modules.md: the answer is a byte/code-unit size
//    check, a JSON parse, four DoS bounds and a per-server summary all computed
//    FROM the text, so no constant is honest. `{status: 'valid', servers: []}`
//    would read as "this config parses and declares no servers", and it would
//    say it about a 300 KiB config — the exact answer the config-size bound
//    exists to refuse. The ready core always answers an object, so `null` can
//    never be misread as an answer.
//    Branched on by `loadMcpConfigInspections`
//    (components/settings/mcp-config-inspection.ts), which throws
//    `McpConfigInspectionUnavailableError` rather than invent a row for a file
//    that exists; `McpConfigSection` catches it, shows the preparing/unavailable
//    banner instead of a server list, and re-runs the load on the availability
//    edge it subscribes to.
//
// A THIRD DIVERGENCE, outside `env` and deliberate: config text holding an
// ESCAPED lone surrogate (`"a\ud800b"` — six ASCII characters, so it crosses the
// codec fine). `JSON.parse` accepts it and `serde_json` cannot, because a Rust
// String has nowhere to put an unpaired surrogate. The core now retries such a
// document with each unpaired escape rewritten to U+FFFD, so the servers stay
// listed instead of the whole file reading `invalid` with an EMPTY pane; the
// residual is one substituted character in whatever string carried it (and a
// name collision if two names differ ONLY by which surrogate they hold). Not
// closable from this side either: the codec below refuses to carry a lone
// surrogate at all. Pinned by the Rust tests in rust/crates/orca-config/src/
// mcp.rs — NOT by a case here, because the committed wasm blob predates the fix
// and still answers `invalid`; add the renderer case with the next
// `pnpm build:relay-wasm`.
//
// TWO KNOWN PORT DIVERGENCES, both reachable from here and both confined to a
// server's `env` (rendered by McpConfigFileRow; never persisted, keyed, or
// compared). Pinned by mcp-config-content-inspection.test.ts so a fix flips a
// test red:
//  * an `__proto__` env KEY now survives into the summary. The twin's
//    `masked[key] = value` hit Object.prototype's `__proto__` setter and dropped
//    it silently. Nothing here can pollute a prototype: the result is decoded
//    with JSON.parse and copied with object spread, both of which define an own
//    data property.
//  * an env VALUE that is a JSON float can print one ULP off (~28% of random
//    doubles measured through this seam, e.g. 2.225073858507201e-308 →
//    2.2250738585072014e-308) — the vendored serde_json is built without
//    float_roundtrip.
import type { McpConfigCandidate, McpConfigInspection } from '../../../../shared/mcp-config'
import { isGitWasmReady } from './git-wasm-availability'
import { dispatchToWasmCore } from './wasm-core-dispatch'

// Why the overload pair rather than one nullable signature: the absent-file
// answer is a constant, so that call class provably never yields the sentinel and
// its callers must not be made to branch on one that cannot arrive.
export function inspectMcpConfigContent(
  candidate: McpConfigCandidate,
  content: null
): McpConfigInspection
export function inspectMcpConfigContent(
  candidate: McpConfigCandidate,
  content: string | null
): McpConfigInspection | null
export function inspectMcpConfigContent(
  candidate: McpConfigCandidate,
  content: string | null
): McpConfigInspection | null {
  if (!isGitWasmReady()) {
    return content === null ? { candidate, exists: false, status: 'missing', servers: [] } : null
  }
  return dispatchToWasmCore('mcp', 'inspectMcpConfigContent', {
    candidate,
    content
  }) as McpConfigInspection
}
