// The workspace-session parse/repair (parseWorkspaceSession + its zod schema)
// moved to the Rust orca-config core: the main process drives it through the
// napi addon (src/main/rust-workspace-session-parse.ts). This shared module
// keeps only the result type that boundary and the parity dispatch reference.
//
// Why the schema existed: session JSON written by older builds is read back by
// newer ones, so validating at the read boundary collapses any garbage (a
// field-type flip, a truncated write) to "use defaults" — never letting it
// reach React or throw into main.
//
// TODO(upstream-merge v1.4.165): the Rust parser is a strict allowlist (it
// rebuilds the object from known keys, so unknown keys are dropped by design —
// see the drift-pass note in orca-dispatch/src/modules/workspace_session_schema.rs).
// A field upstream adds to its zod schema is silently stripped on every load
// until it is mirrored in rust/crates/orca-config/src/workspace_session_schema.rs,
// even though WorkspaceSessionState (types.ts) declares it and the renderer
// already reads it. Still to add:
//   activeWorkspaceExecutionHostId -> nullable ExecutionHostId (parseExecutionHostId)
// Until then a folder workspace's active execution host (ssh target / runtime
// env) falls back to local on every restart.
import type { WorkspaceSessionState } from './types'

/** Validate raw JSON as a WorkspaceSessionState. Returns a discriminated union
 *  so callers can fall back to defaults on failure without a try/catch. */
export type ParsedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState }
  | { ok: false; error: string }
