/**
 * Story World's copy rules, as code — `docs/reference/app-modes.md` §7.8.
 *
 * The rules are enforceable, so they are enforced rather than described. A
 * child-facing surface that says "error" or shows a file path has failed, and a
 * lint rule cannot catch it because the string is data.
 *
 * Rule 4 is the subtle one. There are FIVE status words for EIGHT
 * `AgentDotState` members, so the mapping has to be total: an unmapped state
 * would fall through to whatever the underlying status string is — which is
 * exactly the vocabulary this mode exists to hide. "Ready" covers `idle` and
 * no-status-yet, which is the state of a world the child just opened.
 */

/** §7.8 rule 3. Never shown to a child, in any surface, for any reason. */
export const BANNED_CHILD_FACING_WORDS: readonly string[] = [
  'error',
  'failed',
  'failure',
  'exception',
  'null',
  'undefined',
  'stack',
  'traceback',
  'exit code',
  'stderr',
  // §7.8 bans GIT TERMS too, which the first version of this list omitted.
  'git',
  'commit',
  'branch',
  'merge',
  'repository',
  'repo',
  'worktree',
  'crash',
  'invalid',
  'timeout'
]

/** Paths, hashes and ports are banned as SHAPES rather than words. */
const BANNED_SHAPES: readonly RegExp[] = [
  // A POSIX path anywhere in the string, not only after whitespace — the first
  // version missed `("/home/kid/game.js")` because of the leading paren.
  /[~/][\w.-]+\/[\w./-]*/,
  // A Windows path: C:\Users\kid\game.js
  /\b[A-Za-z]:\\[^\s]*/,
  // A relative source path: src/game.js — no leading slash, so the rules above
  // never saw it.
  /\b[\w-]+\/[\w-]+\.[A-Za-z]{1,5}\b/,
  // A bare filename with a code-ish extension.
  /\b[\w-]+\.(?:js|ts|tsx|json|html|css|log|sh)\b/i,
  /\b[0-9a-f]{7,40}\b/i, // a git hash
  /\blocalhost:\d+|\b:\d{2,5}\b/, // a port
  /\bhttps?:\/\//i // a URL
]

/**
 * The five status words. Total over all eight `AgentDotState` members by
 * construction — the Record type makes a new member a compile error rather than
 * a silent fallthrough to raw agent vocabulary.
 */
export type StoryStatusWord = 'Working' | 'Your turn' | 'Done' | 'Stuck' | 'Ready'

export type StoryAgentState =
  | 'working'
  | 'blocked'
  | 'waiting'
  | 'interrupted'
  | 'failed'
  | 'done'
  | 'idle'
  | 'permission'

export const STORY_STATUS_WORDS: Record<StoryAgentState, StoryStatusWord> = {
  working: 'Working',
  // Both mean "the machine is waiting on the child", which is one idea to her.
  blocked: 'Your turn',
  waiting: 'Your turn',
  permission: 'Your turn',
  done: 'Done',
  // `interrupted` and `failed` are the same event to a six-year-old: it stopped
  // and it was not supposed to. She cannot act on the difference.
  interrupted: 'Stuck',
  failed: 'Stuck',
  idle: 'Ready'
}

/** No status yet is the state of a world she just opened — not an error. */
export function storyStatusWord(state: StoryAgentState | null | undefined): StoryStatusWord {
  return state ? STORY_STATUS_WORDS[state] : 'Ready'
}

/**
 * True when a string is safe to show a child. Exported so the copy test can
 * sweep every child-facing string rather than trusting review.
 */
export function isChildSafeCopy(text: string): boolean {
  const lower = text.toLowerCase()
  if (BANNED_CHILD_FACING_WORDS.some((word) => lower.includes(word))) {
    return false
  }
  return !BANNED_SHAPES.some((shape) => shape.test(text))
}

/** §7.8 rule 1: five words maximum per button, four preferred. */
export function isButtonLabelShortEnough(label: string): boolean {
  return label.trim().split(/\s+/).filter(Boolean).length <= 5
}
