// Why: OpenCode abbreviates native OSC session titles as `OC | <task>` (no
// agent-name token). A wrapper may prepend an SSH/tmux label (multi-word, so the
// prefix allows spaces), and OpenCode may prepend one status glyph (spinner or
// ▣). The wrapper cannot itself start with a glyph, so a spinner-led task from
// another agent (`⠋ Fix foo | OC | …`) never masquerades as a wrapper. The
// separator is the literal spaced ` | ` OpenCode emits — `OC|x` is another
// tool's pipe-delimited title. Case-sensitive `OC` avoids lowercase lookalikes;
// require non-whitespace after the marker so bare `OC |` is not identity.
const OPENCODE_NATIVE_TITLE_RE = /^\s*(?:(?![▣⠀-⣿])[^|]+? \| )?(?:[▣⠀-⣿] )?OC \|[ \t]+\S/u

export function isOpenCodeNativeTitle(title: string | null | undefined): boolean {
  return title ? OPENCODE_NATIVE_TITLE_RE.test(title) : false
}

export function isMeaningfulOpenCodeTerminalTitle(title: string | null | undefined): boolean {
  return isOpenCodeNativeTitle(title)
}
