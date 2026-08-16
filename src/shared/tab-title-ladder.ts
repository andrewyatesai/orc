// Both tab-title resolvers on the Rust `orca_core::tab_title_resolution` core.
//
// This sits on `orca-dispatch-seam` rather than in
// `src/renderer/src/lib/git-wasm/` because the twin it replaces was a
// `src/shared` module: `tools/parity/dispatch/tab-title-resolution.ts` drives it
// from outside the renderer, and a `src/shared` module cannot import a
// surface-specific binding. Every production caller is renderer today —
// `tab-bar/TabBar.tsx`, `floating-terminal/FloatingTerminalPanel.tsx`,
// `tab-bar/recent-tab-switching.ts`, `tab-group/useTabGroupWorkspaceModel.ts`,
// `lib/workspace-tab-palette-search.ts`, `runtime/sync-runtime-graph.ts`,
// `store/pinned-tab-close-guard.ts` — so the seam is UNBOUND until wasm init,
// and if wasm never lands the fallback below is the answer for the whole
// session, not for a boot blip.
//
// PRE-READY CONTRACT — `parity` x2, and it is FORCED, not tidy:
//  * Both exports return a total string, and `''` is already the twin's own
//    default `fallback` — the value every caller reads as "nothing usable, use
//    my own default". There is no spare state left for a sentinel, and no
//    constant is honest either, because the answer is a RANKING over the input
//    (ported-modules.md case 3).
//  * The answers are not cosmetic. `TabBar.tsx` feeds the resolved title to
//    `resolveCommittedTerminalTitleAgentType`, so a wrong string flips a tab's
//    agent identity; `runtime/sync-runtime-graph.ts` publishes it to paired
//    mobile clients, so it leaves the app.
// So each fallback recomputes the deleted twin's body verbatim over the kept
// parts types and the TypeScript `isMeaningfulOpenCodeTerminalTitle`, which
// stays implemented in `opencode-terminal-title.ts` precisely so this fallback
// has something to call — a fallback that dispatches is not a fallback.
//
// Each fallback is computed EAGERLY, before the dispatch, and that is the whole
// bound-vs-unbound story for this module. Every step reads its field with
// `?.trim()`, so a NON-STRING field is a TypeError in the twin, while the
// adapter's `Value::as_str` reads it as absent and the bound core answers the
// next candidate instead. Tab titles are whatever a PTY wrote in an OSC 0/2
// sequence and also arrive from persisted layout JSON and off the SSH/relay
// wire, so a non-string is reachable, not hypothetical. Computing the twin's
// body first means the TypeError is thrown before anything crosses, in both
// seam states. The same reasoning covers `aiVaultTitle` with a missing or
// non-string `.title`: the twin's `aiVaultTitle?.title.trim()` has no optional
// chain on `.title`.
//
// Three more guards cover the rest of the adapter's reading.
// `generatedTitlesEnabled` is read with `as_bool`, so a truthy non-boolean would
// silently mean `false` and drop the generated title; `fallback` is read with
// `as_str`, and the twin RETURNS a non-string fallback unchanged where the core
// answers `""`; and a lone UTF-16 surrogate cannot be encoded at all, so
// `DispatchPayloadError` is caught and answered locally. `crossableSlots` then
// keeps a non-string slot from crossing even when the ladder never evaluated it
// — belt and braces behind the eager fallback, and the reason the payload is
// built from five checked strings rather than handing the caller's tab record
// to the encoder.
// Each of the four classes has a test that was watched failing with its guard
// removed; a test never seen fail proves nothing.
//
// MEASURED, not assumed: 90,840 fallback answers compared against BOTH shipped
// artifacts (`orca_git_wasm_bg.wasm` and `orca_node.node`), 181,680 comparisons
// — the full 5-slot cross product over a reduced candidate set, every candidate
// in every slot over four backgrounds, all ten pairwise slot sweeps over a set
// carrying blank/whitespace/`OC |` marker variants plus U+0085, U+FEFF, U+3000,
// astral and combining text, and 5k randomized tabs, each run with both
// `generatedTitlesEnabled` states and both an empty and a non-empty fallback —
// 0 divergences on either core. The corpus is discriminating: deleting the
// vault step from the fallback (the regression this cutover was refused for)
// reddens 4,012 cases, and swapping JS `.trim()` for a Rust
// `char::is_whitespace` trim reddens 2,364.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import type {
  TabAiVaultTitle,
  TerminalTabTitleParts,
  UnifiedTabLabelParts
} from './tab-title-resolution'

export type {
  TabAiVaultTitle,
  TerminalTabTitleParts,
  UnifiedTabLabelParts
} from './tab-title-resolution'

const TAB_TITLE_RESOLUTION = 'tab-title-resolution'

/** The wire shape the Rust adapter reads; `null` is its "absent". */
type CrossableTab = {
  custom: string | null
  quickCommandLabel: string | null
  aiVaultTitle: { title: string } | null
  generated: string | null
  live: string | null
}

/** The deleted twin's body, verbatim. */
function legacyResolveTerminalTabTitle(
  tab: TerminalTabTitleParts,
  generatedTitlesEnabled: boolean,
  fallback: string
): string {
  const liveTitle = tab.title?.trim() ?? ''
  return (
    tab.customTitle?.trim() ||
    tab.quickCommandLabel?.trim() ||
    (isMeaningfulOpenCodeTerminalTitle(liveTitle) ? liveTitle : '') ||
    tab.aiVaultTitle?.title.trim() ||
    (generatedTitlesEnabled ? tab.generatedTitle?.trim() : '') ||
    liveTitle ||
    fallback
  )
}

/** The deleted twin's body, verbatim. */
function legacyResolveUnifiedTabLabel(
  tab: UnifiedTabLabelParts | undefined,
  generatedTitlesEnabled: boolean,
  fallback: string
): string {
  const liveLabel = tab?.label?.trim() ?? ''
  return (
    tab?.customLabel?.trim() ||
    tab?.quickCommandLabel?.trim() ||
    (isMeaningfulOpenCodeTerminalTitle(liveLabel) ? liveLabel : '') ||
    tab?.aiVaultTitle?.title.trim() ||
    (generatedTitlesEnabled ? tab?.generatedLabel?.trim() : '') ||
    liveLabel ||
    fallback
  )
}

/** What a `?.trim()` step accepts without throwing: a string, or nothing. */
function isTitleText(value: unknown): value is string | null | undefined {
  return typeof value === 'string' || value === null || value === undefined
}

/** The twin reads `.title` off the vault object with no optional chain, so a
 *  nullish vault is absent and anything else is read through. */
function vaultTitleText(vault: TabAiVaultTitle | null | undefined): unknown {
  return vault === null || vault === undefined ? null : vault.title
}

/** The five slots normalized for the wire, or `null` when one of them is a
 *  shape the core's adapter reads differently from the twin. */
function crossableSlots(
  custom: unknown,
  quickCommandLabel: unknown,
  vault: TabAiVaultTitle | null | undefined,
  generated: unknown,
  live: unknown
): CrossableTab | null {
  const vaultTitle = vaultTitleText(vault)
  if (
    !isTitleText(custom) ||
    !isTitleText(quickCommandLabel) ||
    !isTitleText(vaultTitle) ||
    !isTitleText(generated) ||
    !isTitleText(live)
  ) {
    return null
  }
  return {
    custom: custom ?? null,
    quickCommandLabel: quickCommandLabel ?? null,
    aiVaultTitle: vaultTitle === null || vaultTitle === undefined ? null : { title: vaultTitle },
    generated: generated ?? null,
    live: live ?? null
  }
}

/** `null` = the seam is unbound, or the payload cannot cross — answer locally.
 *  Unambiguous: both arms answer a string, never null. The catch is required,
 *  not defensive: a tab title is arbitrary text an agent CLI wrote in an OSC 0/2
 *  sequence and relayed over SSH, so an unpaired UTF-16 surrogate is reachable
 *  and the codec refuses to encode one (it is not valid UTF-8, so Rust cannot
 *  parse the payload at all). The twin answered those without crossing
 *  anything, so the fallback does too; a DispatchCoreError still propagates. */
function dispatchTabTitle(fn: string, input: unknown): unknown {
  try {
    return tryOrcaDispatch(TAB_TITLE_RESOLUTION, fn, input, { root: fn })
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

/**
 * The tab-bar title for a terminal tab: manual rename → quick-command label →
 * a native `OC | …` OpenCode session title → the AI Vault conversation name →
 * the Orca-generated title (only when that setting is on) → the live PTY title
 * → `fallback`. Each candidate is trimmed and blank counts as absent.
 */
export function resolveTerminalTabTitle(
  tab: TerminalTabTitleParts,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  // Eager, so a non-string slot throws the twin's own TypeError rather than a
  // dispatch error — or, worse, quietly resolving to the next candidate.
  const local = legacyResolveTerminalTabTitle(tab, generatedTitlesEnabled, fallback)
  if (typeof generatedTitlesEnabled !== 'boolean' || typeof fallback !== 'string') {
    return local
  }
  const slots = crossableSlots(
    tab.customTitle,
    tab.quickCommandLabel,
    tab.aiVaultTitle,
    tab.generatedTitle,
    tab.title
  )
  if (!slots) {
    return local
  }
  const answer = dispatchTabTitle('resolveTerminalTabTitle', {
    tab: {
      customTitle: slots.custom,
      quickCommandLabel: slots.quickCommandLabel,
      aiVaultTitle: slots.aiVaultTitle,
      generatedTitle: slots.generated,
      title: slots.live
    },
    generatedTitlesEnabled,
    fallback
  })
  return answer === null ? local : (answer as string)
}

/**
 * The same ladder for a unified tab of any content type, over its label fields.
 * `tab` is optional because callers resolve a label for a tab id that may have
 * already closed; an absent tab answers `fallback`.
 */
export function resolveUnifiedTabLabel(
  tab: UnifiedTabLabelParts | undefined,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const local = legacyResolveUnifiedTabLabel(tab, generatedTitlesEnabled, fallback)
  if (typeof generatedTitlesEnabled !== 'boolean' || typeof fallback !== 'string') {
    return local
  }
  // A nullish tab is the twin's optional chain short-circuiting, which the
  // adapter spells as a null `tab`; it is an answer, not a missing payload.
  const absentTab = tab === null || tab === undefined
  const slots = absentTab
    ? null
    : crossableSlots(
        tab.customLabel,
        tab.quickCommandLabel,
        tab.aiVaultTitle,
        tab.generatedLabel,
        tab.label
      )
  if (!absentTab && !slots) {
    return local
  }
  const answer = dispatchTabTitle('resolveUnifiedTabLabel', {
    tab: slots
      ? {
          customLabel: slots.custom,
          quickCommandLabel: slots.quickCommandLabel,
          aiVaultTitle: slots.aiVaultTitle,
          generatedLabel: slots.generated,
          label: slots.live
        }
      : null,
    generatedTitlesEnabled,
    fallback
  })
  return answer === null ? local : (answer as string)
}
