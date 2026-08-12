/**
 * PR #11573 — Editor Font Family was shipping untranslated English in es/ja/ko/zh.
 * Guards the shipped locale catalogs so a bootstrap re-translation cannot silently
 * regress these back to the English fallback.
 */
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

function findString(node: unknown, key: string): string | undefined {
  if (!node || typeof node !== 'object') {
    return undefined
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findString(item, key)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }
  const record = node as Record<string, unknown>
  if (typeof record[key] === 'string') {
    return record[key] as string
  }
  for (const value of Object.values(record)) {
    const found = findString(value, key)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

function findObject(node: unknown, key: string): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') {
    return undefined
  }
  const record = node as Record<string, unknown>
  if (record[key] && typeof record[key] === 'object' && !Array.isArray(record[key])) {
    return record[key] as Record<string, unknown>
  }
  for (const value of Object.values(record)) {
    const found = findObject(value, key)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

const expected = {
  es: {
    editorFontFamily: 'Fuente del editor',
    editorFontFamilyDesc:
      'Fuente utilizada por los editores de archivos y vistas de diferencias. Dejar vacío para seguir la fuente de la terminal.',
    placeholder: 'Igual que la fuente de la terminal',
  },
  ja: {
    editorFontFamily: 'エディターフォント',
    editorFontFamilyDesc: 'ファイルエディターと差分ビューで使用されるフォント。空の場合は端末フォントに従います。',
    placeholder: '端末フォントと同じ',
  },
  ko: {
    editorFontFamily: '편집기 글꼴',
    editorFontFamilyDesc: '파일 편집기 및 diff 보기에서 사용되는 글꼴입니다. 비워두면 터미널 글꼴을 따릅니다.',
    placeholder: '터미널 글꼴과 동일',
  },
  zh: {
    editorFontFamily: '编辑器字体',
    editorFontFamilyDesc: '文件编辑器和差异视图使用的字体。留空则跟随终端字体。',
    placeholder: '与终端字体相同',
  },
} as const

const catalogs = { es, ja, ko, zh } as const

describe('Editor Font Family locale translations (#11573)', () => {
  for (const [locale, want] of Object.entries(expected)) {
    const catalog = catalogs[locale as keyof typeof catalogs]

    it(`${locale}: settings row keys are translated, not the English fallback`, () => {
      expect(findString(catalog, 'editorFontFamily')).toBe(want.editorFontFamily)
      expect(findString(catalog, 'editorFontFamilyDesc')).toBe(want.editorFontFamilyDesc)
      // The regression this fixes: identical to en means it never got translated.
      expect(findString(catalog, 'editorFontFamily')).not.toBe(findString(en, 'editorFontFamily'))
    })

    it(`${locale}: EditorFontFamilySetting block is translated`, () => {
      const block = findObject(catalog, 'EditorFontFamilySetting')
      expect(block).toBeDefined()
      expect(block?.title).toBe(want.editorFontFamily)
      expect(block?.description).toBe(want.editorFontFamilyDesc)
      expect(block?.placeholder).toBe(want.placeholder)
      expect(block?.placeholder).not.toBe(findObject(en, 'EditorFontFamilySetting')?.placeholder)
    })
  }
})
