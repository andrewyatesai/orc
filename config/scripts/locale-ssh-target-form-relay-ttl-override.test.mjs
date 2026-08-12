import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { repairTranslatedValue, LOCALE_KEY_OVERRIDES } from './locale-translation-policy.mjs'

// SshTargetForm hint: "Remote terminals keep running after Orca disconnects from this host."
// Its stale ko override held a truncated relay-TTL sentence that actually translated the sibling
// "Timeout after disconnect (seconds)" key — so the field rendered someone else's string.
const HINT_KEY = 'auto.components.settings.SshTargetForm.137e88ce8d'
const HINT_EN = 'Remote terminals keep running after Orca disconnects from this host.'

// The sibling relay-TTL / timeout key the stale sentence really belonged to.
const SIBLING_KEY = 'auto.components.settings.SshTargetForm.55c56cf2c7'

// The truncated relay-TTL sentence that must never re-enter this key (ended mid-clause at "최대:").
const STALE_RELAY_TTL = '연결 해제 후 릴레이가 terminals을 활성 상태로 유지하는 기간입니다. 기본값: 10800(3시간). 최대:'

function shippedKo() {
  return JSON.parse(
    fs.readFileSync(new URL('../../src/renderer/src/i18n/locales/ko.json', import.meta.url), 'utf8')
  )
}

describe('SshTargetForm relay-TTL ko override', () => {
  it('renders its own source through the repair path, not the sibling relay-TTL sentence', () => {
    // Real catalog-repair entry point (what verify-localization-catalog runs), not a hand-built double.
    const repaired = repairTranslatedValue({ key: HINT_KEY, enValue: HINT_EN, localeValue: 'x', locale: 'ko' })
    expect(repaired).toBe('Orca가 이 호스트에서 연결 해제된 뒤에도 원격 터미널은 계속 실행됩니다.')
    // The defect was rendering the sibling "Timeout after disconnect" string here.
    const sibling = shippedKo().auto.components.settings.SshTargetForm['55c56cf2c7']
    expect(repaired).not.toBe(sibling)
    expect(repaired).not.toContain('최대')
    expect(LOCALE_KEY_OVERRIDES[SIBLING_KEY]).toBeUndefined()
  })

  it('rejects the stale truncated relay-TTL sentence so a catalog --fix cannot revert it', () => {
    // Plant the exact regression: if the pin ever holds the truncated sentence again, this fails.
    expect(LOCALE_KEY_OVERRIDES[HINT_KEY].ko).not.toBe(STALE_RELAY_TTL)
    expect(LOCALE_KEY_OVERRIDES[HINT_KEY].ko.endsWith('최대:')).toBe(false)
  })

  it('keeps shipped ko.json in sync with the pin so repair is a no-op', () => {
    // If the catalog drifts from the repaired pin, the next --fix rewrites it — the exact defect this fixes.
    const shipped = shippedKo().auto.components.settings.SshTargetForm['137e88ce8d']
    const repaired = repairTranslatedValue({ key: HINT_KEY, enValue: HINT_EN, localeValue: shipped, locale: 'ko' })
    expect(shipped).toBe(LOCALE_KEY_OVERRIDES[HINT_KEY].ko)
    expect(repaired).toBe(shipped)
  })
})
