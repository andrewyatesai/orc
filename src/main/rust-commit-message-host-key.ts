// Main-process commit-message model-discovery host key, driven by the Rust
// commit_message_host_key core via napi (the shared TS twin is reduced to its
// constants). One source of truth with the parity-proven Rust port.
//
// No pre-ready case here, unlike the renderer shim
// (src/renderer/src/lib/git-wasm/commit-message-host-key.ts):
// `requireRustGitBinding()` loads the addon synchronously and throws if it
// cannot, so this either answers or fails loudly — it never returns a
// placeholder key that could index a cache for the rest of the session.
import { dispatchToRustCore } from './rust-core-dispatch'

/**
 * Namespace key for cached commit-message model discovery on an SSH connection:
 * `unknown` when the connection is undefined, `local` when there is none, else
 * `ssh:<connectionId>`.
 */
export function getCommitMessageModelDiscoveryHostKey(
  connectionId: string | null | undefined
): string {
  // Why the scope entry: it is the module's only registered dispatch function and
  // it delegates to the connection-id form for every input that is not
  // `runtime:`-prefixed — a reserved execution-host namespace (execution-host.ts),
  // never a connection id, and every caller here passes `X.connectionId ?? null`.
  //
  // Why 'omit': undefined must cross as an ABSENT key (serde None → `unknown`);
  // an explicit null is the distinct falsy → `local` case.
  return dispatchToRustCore(
    'commit-message-host-key',
    'getCommitMessageModelDiscoveryHostKeyForScope',
    { scope: connectionId },
    { undefinedProperties: 'omit' }
  ) as string
}
