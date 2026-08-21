/**
 * #5640 (port of 1aa5e7f89) — 12 source-control strings were still shipping the
 * English fallback: the ja PR primary-action blocked reasons and the ko "Diverged"
 * pull-policy notice. Guards the shipped catalogs at the exact production paths so a
 * bootstrap re-translation cannot silently regress them back to English.
 */
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'

function resolve(node: unknown, path: readonly string[]): unknown {
  let current: unknown = node
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

// The exact production node the source-control sidebar reads its blocked reasons from.
const JA_ACTION_PATH = [
  'auto',
  'components',
  'right',
  'sidebar',
  'source',
  'control',
  'primary',
  'action'
] as const

// The pull-policy notice node (distinct from the RepositoryForkSyncSection "diverged").
const KO_NOTICE_PATH = [
  'auto',
  'components',
  'right',
  'sidebar',
  'pull',
  'policy',
  'notice'
] as const

const jaActionReasons: Record<string, string> = {
  b8e4f2a901: 'リモート操作が終了するまでお待ちください。',
  c9f3a1b802: '{{value0}} を作成する前に競合を解決してください。',
  d2a8c4e703: 'このブランチに {{value0}} に含める変更はありません。',
  e3b9d5f814: 'デフォルトブランチから {{value0}} を作成することはできません。',
  f4c0e6a925: '{{value0}} を作成する前に変更を commit してください。',
  a5d1f7b036: '{{value0}} を作成する前に commit を公開してください。',
  b6e2a8c147: '{{value0}} を作成する前に commit をプッシュしてください。',
  c7f3b9d258: '{{value0}} を作成する前にこのブランチを同期してください。',
  d8a4c0e369: '{{value0}} を作成する前に認証してください。',
  e9b5d1f470: '{{value0}} を作成する前にブランチをチェックアウトしてください。',
  f0c6e2a581: 'このブランチはまだ {{value0}} の準備ができていません。',
  h3i4j5k607: 'このブランチが {{value0}} を作成できるか確認中…'
}

describe('pull-policy / PR-action reason locale translations (#5640)', () => {
  const jaAction = resolve(ja, JA_ACTION_PATH) as Record<string, string> | undefined
  const enAction = resolve(en, JA_ACTION_PATH) as Record<string, string> | undefined

  it('ja: the source-control primary-action block resolves to the production node', () => {
    expect(jaAction).toBeDefined()
    expect(enAction).toBeDefined()
  })

  for (const [key, want] of Object.entries(jaActionReasons)) {
    it(`ja: blocked reason ${key} is translated, not the English fallback`, () => {
      expect(jaAction?.[key]).toBe(want)
      // The regression this fixes: identical to en means it never got translated.
      expect(jaAction?.[key]).not.toBe(enAction?.[key])
    })
  }

  it('ko: the pull-policy "diverged" notice is translated, not the English fallback', () => {
    const koNotice = resolve(ko, KO_NOTICE_PATH) as Record<string, string> | undefined
    const enNotice = resolve(en, KO_NOTICE_PATH) as Record<string, string> | undefined
    expect(koNotice?.diverged).toBe('분기됨')
    expect(enNotice?.diverged).toBe('Diverged')
    expect(koNotice?.diverged).not.toBe(enNotice?.diverged)
  })
})
