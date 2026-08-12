import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_SPANISH
} from '../../../shared/ui-language'
import en from './locales/en.json'
import { i18n, translate } from './i18n'

// #10672 — the browser.loadFailure.* copy the load-failure overlay renders had
// shipped raw English in es/ja/ko (and 6 stragglers in zh). Guard the translated
// copy through the real translate() path the overlay uses, and prove none of the
// fixed keys still echo their English fallback.
const HOST = 'example.com'
const OPTS = { value0: HOST }
const enLoadFailure = en.browser.loadFailure as Record<string, string>
const ALL_KEYS = Object.keys(enLoadFailure)

// zh had already localized the other keys via #12368; this commit reached only
// these 6.
const ZH_FIXED_KEYS = [
  'cantReachHost',
  'retry',
  'copyAddress',
  'openExternally',
  'tryHttps',
  'connecting'
]

function render(key: string): string {
  return translate(`browser.loadFailure.${key}`, enLoadFailure[key], OPTS)
}

// Exact upstream copy, {{value0}} already interpolated with HOST.
const EXPECTED: Record<string, Record<string, string>> = {
  [UI_LANGUAGE_SPANISH]: {
    connectionNotSecure: 'La conexión no es segura',
    cantReachHost: `No se puede acceder a ${HOST}`,
    retry: 'Reintentar',
    copyAddress: 'Copiar dirección',
    openExternally: 'Abrir externamente',
    tryHttps: 'Probar HTTPS',
    connecting: 'Conectando…'
  },
  [UI_LANGUAGE_JAPANESE]: {
    connectionNotSecure: '接続は安全ではありません',
    cantReachHost: `${HOST} に接続できません`,
    retry: '再試行',
    copyAddress: 'アドレスをコピー',
    openExternally: '外部で開く',
    tryHttps: 'HTTPS を試す',
    connecting: '接続中…'
  },
  [UI_LANGUAGE_KOREAN]: {
    connectionNotSecure: '연결이 안전하지 않습니다',
    cantReachHost: `${HOST}에 연결할 수 없습니다`,
    retry: '다시 시도',
    copyAddress: '주소 복사',
    openExternally: '외부에서 열기',
    tryHttps: 'HTTPS로 시도',
    connecting: '연결 중…'
  },
  [UI_LANGUAGE_CHINESE]: {
    cantReachHost: `无法访问 ${HOST}`,
    retry: '重试',
    copyAddress: '复制地址',
    openExternally: '在外部打开',
    tryHttps: '尝试 HTTPS',
    connecting: '正在连接…'
  }
}

describe('browser.loadFailure locale copy (#10672)', () => {
  const englishCopy: Record<string, string> = {}

  beforeAll(async () => {
    await i18n.changeLanguage(UI_LANGUAGE_ENGLISH)
    for (const key of ALL_KEYS) {
      englishCopy[key] = render(key)
    }
  })

  beforeEach(async () => {
    await i18n.changeLanguage(UI_LANGUAGE_ENGLISH)
  })

  it.each([UI_LANGUAGE_SPANISH, UI_LANGUAGE_JAPANESE, UI_LANGUAGE_KOREAN])(
    'localizes every loadFailure key in %s (no raw English echo)',
    async (language) => {
      await i18n.changeLanguage(language)
      for (const key of ALL_KEYS) {
        expect(render(key)).not.toBe(englishCopy[key])
      }
      // {{value0}} host token survives translation.
      expect(render('cantReachHost')).toContain(HOST)
      for (const [key, value] of Object.entries(EXPECTED[language])) {
        expect(render(key)).toBe(value)
      }
    }
  )

  it('localizes the 6 zh keys #12368 missed without disturbing the rest', async () => {
    await i18n.changeLanguage(UI_LANGUAGE_CHINESE)
    for (const key of ZH_FIXED_KEYS) {
      expect(render(key)).not.toBe(englishCopy[key])
    }
    expect(render('cantReachHost')).toContain(HOST)
    for (const [key, value] of Object.entries(EXPECTED[UI_LANGUAGE_CHINESE])) {
      expect(render(key)).toBe(value)
    }
  })
})
