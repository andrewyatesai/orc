// Host-key constants for cached commit-message model discovery. The derivation
// moved to the Rust commit_message_host_key core (orca-dispatch); callers use the
// napi wrapper (src/main/rust-commit-message-host-key.ts) or the wasm wrapper
// (src/renderer/src/lib/git-wasm/commit-message-host-key.ts). The constants stay
// here because the renderer shim's pre-ready fallback and the settings resolvers
// compare against them.
export const LOCAL_COMMIT_MESSAGE_HOST_KEY = 'local'
export const UNKNOWN_COMMIT_MESSAGE_HOST_KEY = 'unknown'
export const RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX = 'runtime:'
