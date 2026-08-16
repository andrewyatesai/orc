// Both tab-title resolvers moved to the Rust `orca_core::tab_title_resolution`
// core and are reached through ONE shim on the shared dispatch seam,
// `src/shared/tab-title-ladder.ts`, whose pre-ready fallback rebuilds the
// deleted bodies out of exactly the parts types below. This file is types only.
//
// `aiVaultTitle` is declared STRUCTURALLY here rather than picked off the tab
// records. The ladder reads one field through it (`.title`), and pinning the
// parameter to `Pick<TerminalTab, 'aiVaultTitle'>` makes the resolvers stop
// compiling in any tree that does not carry the vault field — which is how a
// port of this module lost the vault step once already, answering `''` where
// the twin answers the conversation name.

import type { Tab, TerminalTab } from './types'

/** The AI Vault conversation name as the ladder reads it: `.title` and nothing
 *  else, so the agent/session identity it is bound to never has to cross. */
export type TabAiVaultTitle = { title: string }

/** Everything `resolveTerminalTabTitle` reads off a terminal tab. */
export type TerminalTabTitleParts = Pick<
  TerminalTab,
  'customTitle' | 'quickCommandLabel' | 'generatedTitle' | 'title'
> & { aiVaultTitle?: TabAiVaultTitle | null }

/** Everything `resolveUnifiedTabLabel` reads off a unified tab. */
export type UnifiedTabLabelParts = Pick<
  Tab,
  'customLabel' | 'quickCommandLabel' | 'generatedLabel' | 'label'
> & { aiVaultTitle?: TabAiVaultTitle | null }
