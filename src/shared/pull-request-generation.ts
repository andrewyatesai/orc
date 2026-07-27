// Types for the pull-request field generator. The prompt-build + reply-parse
// bodies were DELETED — the Rust `orca-agents::pull_request_generation` core is
// the sole impl (napi in main via ./text-generation/rust-pull-request-generation,
// wasm in the renderer's dry-run preview). See that crate + the parity vectors.

// Ceiling an agent reply must satisfy before it is parsed as JSON (upstream
// v1.4.150). NOT YET ENFORCED: the parse moved to Rust, which has no structural
// guard — assert it on `raw` in ./text-generation/rust-pull-request-generation.
export const GENERATED_PULL_REQUEST_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 64,
  nestingDepth: 8
} as const

export type PullRequestDraftContext = {
  branch: string | null
  base: string
  branchChangedByPreparation: boolean
  currentTitle: string
  currentBody: string
  currentDraft: boolean
  commitSummary: string
  changeSummary: string
  patch: string
  /** Workspace-linked GitHub issue number. Omitted entirely when none resolves. */
  linkedIssue?: number | null
}

export type GeneratedPullRequestFields = {
  base: string
  title: string
  body: string
  draft: boolean
}
