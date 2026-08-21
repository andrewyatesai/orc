import type { CommandTemplateBackslash } from '../../shared/commit-message-prompt'
import type { CommitMessageGenerationTarget } from './commit-message-text-generation'

/**
 * How the user's command override / args / custom command should read `\`.
 *
 * `'literal'` only when the command provably runs on native Windows: a LOCAL
 * target, on win32, with no WSL distro. A WSL target runs a Linux binary inside
 * the distro, and a remote target runs on a host whose platform this process
 * cannot see — POSIX escaping stays the default for both, so a native Windows
 * path in an override is not silently destroyed (#11375). Opt-in from the
 * TARGET, not `process.platform`, because the plan can be built here and run on
 * another host; the mode rides in the plan the Rust planner reads.
 */
export function commandBackslashMode(
  target: CommitMessageGenerationTarget,
  platform: NodeJS.Platform = process.platform
): CommandTemplateBackslash {
  return platform === 'win32' && target.kind === 'local' && !target.wslDistro ? 'literal' : 'escape'
}
