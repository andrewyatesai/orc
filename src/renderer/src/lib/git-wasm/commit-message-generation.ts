// Renderer commit-message prompt builder, driven by the Rust orca-agents core in
// the orca-git wasm module (the shared TS body was deleted). The renderer's only
// use is the generation-dialog PREVIEW, so pre-ready the prompt is null and the
// caller shows nothing until the wasm initialises — the authoritative generator
// runs in the main process (napi).
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type { CommitMessageDraftContext } from '../../../../shared/commit-message-generation'

// Why 'omit': `context.linkedIssue` is documented as omitted entirely when no
// issue resolves, which the Rust struct reads as None.
function op(fn: string, input: unknown): unknown {
  if (!isGitWasmReady()) {
    return null
  }
  return dispatchToWasmCore('commit-message-generation', fn, input, {
    undefinedProperties: 'omit'
  })
}

export function buildCommitMessagePrompt(
  context: CommitMessageDraftContext,
  customPrompt: string
): string | null {
  return op('buildCommitMessagePrompt', { context, customPrompt }) as string | null
}
