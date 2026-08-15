// Renderer repo-badge-color normalizers, driven by the Rust repo-badge-color core
// in the orca-git wasm (the shared TS twin is reduced to types/data; the palette
// and DEFAULT_REPO_BADGE_COLOR live in src/shared/constants.ts).
//
// PRE-READY VALUE: `undefined`, a declared not-ready SENTINEL. The ready core
// returns `string | null` and never `undefined`, so a caller can always tell the
// signal from an answer. This is ported-modules.md case 3 — the deleted TS
// answered FROM THE INPUT (`'#ff0000'` -> `'#ff0000'`, `'nope'` -> `null`, and
// `resolveRepoBadgeColor` returns DEFAULT_REPO_BADGE_COLOR only for an INVALID
// input) — so neither `null` nor the default constant is honest for every input.
// Returning the constant is the exact defect that reverted this cut-over once:
// `ColorPicker.updateColor` persisted default gray over the user's saved repo
// colour on a colour-wheel drag, and `hasInvalidDraft` flagged a valid hex as
// "Invalid hex color".
//
// Handled by (never `?? DEFAULT_REPO_BADGE_COLOR` on a path that can persist):
//  * ColorPicker (components/ui/color-picker.tsx) — subscribes to availability,
//    disables the trigger and suppresses hasInvalidDraft while the core is not
//    ready, so no draft, wheel drag, or blur can reach `onChange`;
//  * store/slices/repos.ts `sanitizeRepoUpdate` — drops `badgeColor` from the
//    update exactly as it does for an invalid colour, so an unvalidated value
//    never enters the store or the persisted repo record;
//  * the read-only badge painters (sidebar/project-header-color.ts,
//    right-sidebar/ai-vault-session-row-display.tsx, settings/RepositoryIcon*) —
//    paint the neutral default for that frame. None of them subscribes to
//    availability, so a swatch can stay neutral until its next render; that is
//    accepted because nothing they render is ever written back.
import { isGitWasmReady } from './git-wasm-availability'
import { dispatchToWasmCore } from './wasm-core-dispatch'

// Why: the codec REJECTS an `undefined` property and every caller feeds an
// unvalidated `repo.badgeColor` (string | null | undefined) straight in. The
// deleted TS answered null/DEFAULT for every non-string, which is what the Rust
// core answers for '', so coerce here instead of widening the wire contract.
function colorArg(value: unknown): { value: string } {
  return { value: typeof value === 'string' ? value : '' }
}

/** `undefined` = core not ready, ask again. `null` = a real "invalid colour". */
export function normalizeRepoBadgeColor(value: unknown): string | null | undefined {
  if (!isGitWasmReady()) {
    return undefined
  }
  return dispatchToWasmCore('repo-badge-color', 'normalizeRepoBadgeColor', colorArg(value)) as
    | string
    | null
}

/** `undefined` = core not ready, ask again. Ready always answers a hex string. */
export function resolveRepoBadgeColor(value: unknown): string | undefined {
  if (!isGitWasmReady()) {
    return undefined
  }
  return dispatchToWasmCore('repo-badge-color', 'resolveRepoBadgeColor', colorArg(value)) as string
}
