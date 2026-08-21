import { beforeEach, describe, expect, it } from 'vitest'

import { UI_LANGUAGE_CHINESE, UI_LANGUAGE_KOREAN } from '../../../shared/ui-language'
import { i18n, translate } from './i18n'

// #10664 — SidebarNav.c86d83b5c3 is the onboarding pill beside Orca Mobile, so
// "New" marks a new feature, not a create action. Both catalogs had shipped the
// create-action sense (ko 새로 만들기, zh 新建), which reads as a button. Guard the
// corrected feature-marker sense through the real translate() path the badge uses.
const BADGE_KEY = 'auto.components.sidebar.SidebarNav.c86d83b5c3'

describe('Orca Mobile "New" badge locale copy (#10664)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('resolves ko to the feature-marker sense, not the create action', async () => {
    await i18n.changeLanguage(UI_LANGUAGE_KOREAN)
    expect(translate(BADGE_KEY, 'New')).toBe('신규')
    expect(translate(BADGE_KEY, 'New')).not.toBe('새로 만들기')
  })

  it('resolves zh to the feature-marker sense, not the create action', async () => {
    await i18n.changeLanguage(UI_LANGUAGE_CHINESE)
    expect(translate(BADGE_KEY, 'New')).toBe('新功能')
    expect(translate(BADGE_KEY, 'New')).not.toBe('新建')
  })
})
