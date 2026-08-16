// All five branch-name exports moved to the Rust branch-name-from-work core
// (orca-core) and are reached through ONE shim on the shared dispatch seam,
// `src/shared/branch-leaf-naming.ts`, because main and the renderer both call
// them. This file is types and data only.
//
// `buildBranchNamePrompt` went last: its header used to argue prompt COPY should
// stay TS so the parity module kept a live TS-vs-Rust comparison. The core has a
// full `build_branch_name_prompt` and a dispatch arm, and the comparison is not
// lost — `tools/parity/dispatch/branch-name-from-work.ts` drives the shim with
// the seam unbound, so the vectors diff the shim's fallback copy against the
// Rust copy.

// Why: post-generation sanitization still bounds the leaf so a long model dump
// cannot become an unreadable branch. The *prompt* stays general — users can
// override naming style via Source Control AI instructions / templates.
export const MAX_BRANCH_NAME_WORDS = 4

export type BranchNameWorkContext = {
  /** The user's first prompt to the agent in this workspace. */
  firstPrompt: string
  /** The agent's first response, when it has already arrived. Optional because
   *  the rename fires as soon as work begins, before a reply may exist. */
  assistantMessage?: string
}
