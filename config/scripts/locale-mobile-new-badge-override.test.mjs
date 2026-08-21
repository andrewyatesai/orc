import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { repairTranslatedValue, LOCALE_KEY_OVERRIDES } from './locale-translation-policy.mjs'

// The Orca Mobile onboarding pill (SidebarNav "New") marks a new feature, not a create action.
const BADGE_KEY = 'auto.components.sidebar.SidebarNav.c86d83b5c3'
const EN_VALUE = 'New'

// "create new" mistranslations that must not survive the catalog repair.
const STALE_CREATE_NEW = { ko: '새로 만들기', zh: '新建', ja: '新規' }

describe('locale mobile new-badge override', () => {
  it('pins the badge to "new feature" wording, not "create new", through the repair path', () => {
    // Real catalog-repair entry point (what verify-localization-catalog runs), not a hand-built double.
    expect(
      repairTranslatedValue({ key: BADGE_KEY, enValue: EN_VALUE, localeValue: 'x', locale: 'ko' })
    ).toBe('신규')
    expect(
      repairTranslatedValue({ key: BADGE_KEY, enValue: EN_VALUE, localeValue: 'x', locale: 'zh' })
    ).toBe('新功能')
    expect(
      repairTranslatedValue({ key: BADGE_KEY, enValue: EN_VALUE, localeValue: 'x', locale: 'ja' })
    ).toBe('新機能')
  })

  it('rejects the stale "create new" override so the next repair cannot revert #10664', () => {
    for (const [locale, stale] of Object.entries(STALE_CREATE_NEW)) {
      expect(LOCALE_KEY_OVERRIDES[BADGE_KEY][locale]).not.toBe(stale)
    }
  })

  it('keeps the shipped catalog in sync with the pin so repair is a no-op', () => {
    // If a catalog value drifts from the pin, repair rewrites it on the next run — the exact defect this fixes.
    for (const locale of ['ko', 'zh', 'ja']) {
      const catalog = JSON.parse(
        fs.readFileSync(
          new URL(`../../src/renderer/src/i18n/locales/${locale}.json`, import.meta.url),
          'utf8'
        )
      )
      const shipped = catalog.auto.components.sidebar.SidebarNav.c86d83b5c3
      expect(shipped).toBe(LOCALE_KEY_OVERRIDES[BADGE_KEY][locale])
      expect(shipped).toBe(
        repairTranslatedValue({ key: BADGE_KEY, enValue: EN_VALUE, localeValue: shipped, locale })
      )
    }
  })
})
