// Renderer commit-message model-discovery host key, driven by the Rust
// commit_message_host_key core in the orca-git wasm module (the shared TS twin
// is reduced to its constants). One source of truth with the parity-proven port.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import {
  LOCAL_COMMIT_MESSAGE_HOST_KEY,
  RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX,
  UNKNOWN_COMMIT_MESSAGE_HOST_KEY
} from '../../../../shared/commit-message-host-key'

/**
 * Namespace key for cached commit-message model discovery: `unknown` for an
 * undefined scope, `local` for none, a `runtime:<env>` scope verbatim, else
 * `ssh:<connectionId>`.
 */
export function getCommitMessageModelDiscoveryHostKeyForScope(
  scope: string | null | undefined
): string {
  if (!isGitWasmReady()) {
    // Pre-ready rebuilds the deleted TS verbatim, for EVERY input (all four
    // branches pinned in shim-pre-ready-contract.test.ts), because this value is
    // a CACHE KEY: it indexes the persisted settings records
    // discoveredModelsByAgentByHost / selectedModelByAgentByHost, and
    // source-control-ai.ts already reads an absent key as LOCAL — so any sentinel
    // would be laundered back into a wrong host key and poison the cache.
    if (scope === undefined) {
      return UNKNOWN_COMMIT_MESSAGE_HOST_KEY
    }
    if (!scope) {
      return LOCAL_COMMIT_MESSAGE_HOST_KEY
    }
    return scope.startsWith(RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX) ? scope : `ssh:${scope}`
  }
  // Why 'omit': an undefined scope must cross as an ABSENT key (serde None →
  // `unknown`); an explicit null is the distinct falsy → `local` case.
  return dispatchToWasmCore(
    'commit-message-host-key',
    'getCommitMessageModelDiscoveryHostKeyForScope',
    { scope },
    { undefinedProperties: 'omit' }
  ) as string
}
