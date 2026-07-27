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
// TODO(upstream-merge v1.4.150): the Rust parser is a strict allowlist (it
// rebuilds the object from known keys, so unknown keys are dropped by design —
// see the drift-pass note in orca-dispatch/src/modules/workspace_session_schema.rs).
// Fields upstream added to its zod schema in this merge that are NOT in that
// allowlist are silently stripped on every load even though
// WorkspaceSessionState (types.ts) declares them and main/renderer already read
// them. `externalSshTargetId` is now ported (persistedOpenFile parser); still to
// add in rust/crates/orca-config/src/workspace_session_schema.rs:
//   terminalPtyIncarnationsByPaneKey -> record(string, string 1..128)
//   terminalTopologyRevisionByRepoId -> record(string, nonneg int)
//   terminalSurfaceTombstonesByPaneKey -> record(string, { worktreeId, parentTabId,
//                                       leafId, ptyId, incarnationId 1..128, retiredAt })
// Until then terminal PTY-incarnation fences, topology revisions and surface
// tombstones do not survive a restart.
import type { WorkspaceSessionState } from './types'

/** Validate raw JSON as a WorkspaceSessionState. Returns a discriminated union
 *  so callers can fall back to defaults on failure without a try/catch. */
export type ParsedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState }
  | { ok: false; error: string }
