/**
 * Cmd+J / Settings-search entries for the Mode pane
 * (`docs/reference/app-modes.md` §3.4).
 *
 * **This module must be imported by `useSettingsNavigationMetadata.ts`** or the
 * pane becomes unreachable by search. That file's own header exists to keep
 * Cmd+J and Settings visibility from drifting apart.
 *
 * The keyword set deliberately includes SYMPTOM phrasing — "sidebar missing",
 * "where are my diffs", "restore", "classic" — because at the moment of
 * confusion the user does not have the word "mode". That is the recovery route
 * a disoriented user is most likely to try.
 */

import type { SettingsSearchEntry } from './settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAppModeEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate('appMode.settings.title', 'Mode'),
    description: translate(
      'appMode.settings.description',
      'Choose how much of Orca is on screen. Switching is instant and changes nothing about your work.'
    ),
    keywords: [
      ...translateSearchKeyword('appMode.search.mode', 'mode'),
      ...translateSearchKeyword('appMode.search.classic', 'classic'),
      ...translateSearchKeyword('appMode.search.alab', 'alab'),
      ...translateSearchKeyword('appMode.search.storyWorld', 'story world'),
      ...translateSearchKeyword('appMode.search.layout', 'layout'),
      ...translateSearchKeyword('appMode.search.restore', 'restore'),
      ...translateSearchKeyword('appMode.search.resetLayout', 'reset layout'),
      ...translateSearchKeyword('appMode.search.sidebarMissing', 'sidebar missing'),
      ...translateSearchKeyword('appMode.search.whereTabs', 'where are my tabs'),
      ...translateSearchKeyword('appMode.search.whereDiffs', 'where are my diffs'),
      ...translateSearchKeyword('appMode.search.missingFiles', 'missing files'),
      ...translateSearchKeyword('appMode.search.backToNormal', 'back to normal'),
    ],
    targetSectionId: 'app-mode'
  }
])
