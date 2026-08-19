// Main-process commit-message prompt builder + generated-message splitter, driven
// by the Rust orca-agents core via napi (the shared TS bodies were deleted). One
// source of truth with the parity-proven Rust port — the dispatch composes the
// diff truncation and output cleaning internally.
import { dispatchToRustCore } from './rust-core-dispatch'
import type {
  CommitMessageDraftContext,
  GeneratedCommitMessage
} from '../shared/commit-message-generation'

export function buildCommitMessagePrompt(
  context: CommitMessageDraftContext,
  customPrompt: string
): string {
  // Why 'omit': `context.linkedIssue` is documented as omitted entirely when no
  // issue resolves, which the Rust struct reads as None.
  return dispatchToRustCore(
    'commit-message-generation',
    'buildCommitMessagePrompt',
    { context, customPrompt },
    { undefinedProperties: 'omit' }
  ) as string
}

export function splitGeneratedCommitMessage(message: string): GeneratedCommitMessage {
  // Rust reads the raw message via `input.as_str()`, so send the bare string.
  return dispatchToRustCore('commit-message-generation', 'splitGeneratedCommitMessage', message, {
    root: 'message'
  }) as GeneratedCommitMessage
}
