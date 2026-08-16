// TS dispatch for the commit-message-models parity module. The parser half of
// `src/shared/commit-message-agent-spec.ts` was DELETED (the twin keeps its
// types, the agent registry and the capability lookups); every surface now
// reaches `orca_agents::commit_message_models` through
// `src/shared/commit-message-model-listing.ts` on the orca-dispatch seam.
//
// Like the tui-agent-selection and agent-scratch-worktrees adapters, this drives
// the SHIM rather than the wasm oracle, so the harness keeps a real TS-vs-Rust
// differential instead of degenerating to wasm-vs-binary:
// `config/vitest.parity.config.ts` installs no setup file, so the seam is unbound
// here and the shim answers from its `parity` fallback — which is the deleted
// twin body, and the code every surface runs before its binding lands.
//
// THE FALLBACK IS NOT THE REFERENCE. It is a transcription of the deleted body,
// so a fallback-vs-Rust comparison is only as good as the copy. The third leg is
// the `expected` golden in the vector file, produced by RUNNING
// `git show HEAD:src/shared/commit-message-agent-spec.ts` (the parsers are gone
// from the working tree but still live in that revision). The driver asserts
// TS == Rust AND TS == golden, so all three have to agree and a drifted
// transcription reddens on its own. Regenerate goldens by running that revision,
// never by hand: four divergence classes hid behind the original 17 cases, which
// never fed the parsers a non-string `slug`, a `null` listing entry, or a
// reasoning-level shape that throws.
//
// One class is deliberately NOT in the corpus: a Codex payload carrying a
// `\uD800`-class ESCAPE. The core cannot represent the parsed value and answers
// `[]` there, so the shim answers it locally — a vector would compare the shim's
// local answer against the core's `[]` and fail for a case that has no crossing.
// It is pinned in `src/shared/commit-message-model-listing.test.ts` instead,
// including a row that asserts the core's `[]` so the guard cannot rot.

import {
  parseAntigravityModels,
  parseCodexModels,
  parseCursorModels,
  parseLineModels,
  parsePiModels
} from '../../../src/shared/commit-message-model-listing'

export function dispatch(fn: string, input: unknown): unknown {
  // Every parser takes a single `stdout` string argument.
  const stdout = input as string
  switch (fn) {
    case 'parseCodexModels':
      return parseCodexModels(stdout)
    case 'parseLineModels':
      return parseLineModels(stdout)
    case 'parsePiModels':
      return parsePiModels(stdout)
    case 'parseCursorModels':
      return parseCursorModels(stdout)
    case 'parseAntigravityModels':
      return parseAntigravityModels(stdout)
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
