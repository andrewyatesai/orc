/** Matches an exact token, the `flag=value` form, and clustered single-dash flags (`-mopus`).
 *  Why shared: grok, claude, codex, and gemini/cursor all gate their picker on the same
 *  user-supplied flag test, so one predicate keeps the spellings in step. */
export function hasFlag(tokens: readonly string[], flags: readonly string[]): boolean {
  return tokens.some((token) =>
    flags.some(
      (flag) =>
        token === flag ||
        token.startsWith(`${flag}=`) ||
        (flag.startsWith('-') && !flag.startsWith('--') && token.startsWith(flag))
    )
  )
}
