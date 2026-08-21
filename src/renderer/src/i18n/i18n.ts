import i18next, {
  type BackendModule,
  type i18n as I18nInstance,
  type ReadCallback,
  type TOptions
} from 'i18next'
import { initReactI18next } from 'react-i18next'

import { isPseudoLocalizationLocale, pseudoLocalizeString } from './pseudo-localization'
import { DEFAULT_LOCALE, resolveUiLocale } from './supported-languages'
import type { SupportedUiLocale } from '../../../shared/ui-locale'
import type { UiLanguage } from '../../../shared/ui-language'

export const i18n: I18nInstance = i18next.createInstance()

// Why: NO catalog is bundled eagerly — not even English. Every translate()/t()
// call site carries its English string inline as defaultValue (enforced by
// verify:localization-catalog, which GENERATES en.json from those fallbacks), so
// the 600KB English catalog is byte-identical redundancy at runtime; bundling it
// eagerly cost its parse on every cold start. English renders from the inline
// defaults over an empty bundled resource (the main process has used this exact
// scheme since main-i18n.ts). The four translated locales load on demand via the
// lazy backend, so any changeLanguage() call transparently fetches its bundle.
const NON_DEFAULT_LOCALE_LOADERS: Record<
  Exclude<SupportedUiLocale, 'en'>,
  () => Promise<{ default: Record<string, unknown> }>
> = {
  es: () => import('./locales/es.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  zh: () => import('./locales/zh.json')
}

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    const loader = NON_DEFAULT_LOCALE_LOADERS[language as Exclude<SupportedUiLocale, 'en'>]
    if (!loader) {
      // English (and unknown locales) are served from bundled resources; signal
      // "nothing to load" so i18next falls back to the in-memory catalog.
      callback(null, false)
      return
    }
    loader().then(
      (mod) => callback(null, mod.default),
      (error) => callback(error instanceof Error ? error : new Error(String(error)), false)
    )
  }
}

void i18n
  .use(lazyLocaleBackend)
  .use(initReactI18next)
  .init({
    fallbackLng: DEFAULT_LOCALE,
    lng: DEFAULT_LOCALE,
    // Why: the empty bundled `en` resource keeps i18next from asking the backend
    // for English (mirrors main-i18n.ts) — English copy comes entirely from the
    // per-call-site defaultValue fallbacks.
    partialBundledLanguages: true,
    resources: {
      en: {
        translation: {}
      }
    },
    interpolation: {
      escapeValue: false
    },
    react: {
      useSuspense: false
    }
  })

// The active UI locale as a BCP-47 tag safe to hand to Intl formatters. i18n.language
// is always a real tag here — a SupportedUiLocale or the en-XA pseudo-locale — so no
// synthetic-tag guard is needed; the fallback only covers the pre-init window.
export function getIntlLocale(): string {
  return i18n.language || DEFAULT_LOCALE
}

export function translate(key: string, fallback: string, options?: TOptions): string {
  const value = i18n.t(key, { defaultValue: fallback, ...options })
  return isPseudoLocalizationLocale(i18n.language) ? pseudoLocalizeString(value) : value
}

export async function setRendererUiLanguage(language: UiLanguage): Promise<void> {
  const locale = resolveUiLocale(language)
  if (i18n.language !== locale) {
    // changeLanguage triggers the lazy backend load for non-English locales and
    // resolves once the catalog is in memory.
    await i18n.changeLanguage(locale)
  }
}
