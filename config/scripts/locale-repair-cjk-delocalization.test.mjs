import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

// Guards against the repair layer rewriting already-correct CJK UI labels back to English
// (or to the wrong sense) on the next catalog regeneration. Each case runs the production
// repairTranslatedValue seam, the same path repairCatalog drives at build time.
describe('locale repair does not de-localize CJK UI labels', () => {
  it('does not rewrite a generic "Open" button to the issue-state 进行中', () => {
    // Guard: a value-wide `Open: '进行中'` override would flip this to 进行中. There is none,
    // so an ordinary key keeps its localized button value.
    expect(
      repairTranslatedValue({
        key: 'auto.components.SomeButton.aaaaaaaaaa',
        enValue: 'Open',
        localeValue: '打开',
        locale: 'zh'
      })
    ).toBe('打开')
  })

  it('keeps the MCP config-file "Open" a verb (打开), not an issue state', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.McpConfigFileRow.e720c139cd',
        enValue: 'Open',
        localeValue: '开放',
        locale: 'zh'
      })
    ).toBe('打开')
  })

  it('maps the issue/PR state "Open" to 开放 / 열림, matching the sibling 已关闭 / 닫힘', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.PullRequestPage.7b8f6bf6d8',
        enValue: 'Open',
        localeValue: '进行中',
        locale: 'zh'
      })
    ).toBe('开放')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.dc1ca081a8',
        enValue: 'Open',
        localeValue: '진행 중',
        locale: 'ko'
      })
    ).toBe('열림')
    expect(
      repairTranslatedValue({
        key: 'auto.components.GitHubItemDialog.dc1ca081a8',
        enValue: 'Open',
        localeValue: '进行中',
        locale: 'zh'
      })
    ).toBe('开放')
  })

  it('translates the workspace status picker labels instead of pinning English', () => {
    const zh = (enValue, localeValue) =>
      repairTranslatedValue({
        key: 'auto.components.sidebar.workspace.status.x',
        enValue,
        localeValue,
        locale: 'zh'
      })
    expect(zh('Play', '玩')).toBe('播放')
    expect(zh('Sky', '天空')).toBe('天蓝')
    expect(zh('Zinc', '锌')).toBe('锌灰')
    expect(
      repairTranslatedValue({
        key: 'auto.components.x.y',
        enValue: 'Play',
        localeValue: '遊ぶ',
        locale: 'ja'
      })
    ).toBe('再生')
  })

  it('reads the Tailwind swatch keys as colors (天蓝/锌灰/空色), not the bare metal/sky', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.workspace.status.6437a8c253',
        enValue: 'Sky',
        localeValue: '天空',
        locale: 'zh'
      })
    ).toBe('天蓝')
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.workspace.status.6437a8c253',
        enValue: 'Sky',
        localeValue: '空',
        locale: 'ja'
      })
    ).toBe('空色')
    expect(
      repairTranslatedValue({
        key: 'auto.components.sidebar.workspace.status.caabd5ca85',
        enValue: 'Zinc',
        localeValue: '锌',
        locale: 'zh'
      })
    ).toBe('锌灰')
  })

  it('resolves the terminal cursor-color group to the on-screen cursor, not the Cursor editor', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.TerminalWindowSection.c9e1fdf42f',
        enValue: 'Cursor',
        localeValue: 'Cursor',
        locale: 'zh'
      })
    ).toBe('光标')
    expect(
      repairTranslatedValue({
        key: 'auto.components.settings.TerminalWindowSection.c9e1fdf42f',
        enValue: 'Cursor',
        localeValue: 'Cursor',
        locale: 'ko'
      })
    ).toBe('커서')
  })

  it('replaces the adjectival 的 color form with the bare noun, not English', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.x.y',
        enValue: 'Blue',
        localeValue: '蓝色的',
        locale: 'zh'
      })
    ).toBe('蓝色')
    expect(
      repairTranslatedValue({
        key: 'auto.components.x.y',
        enValue: 'Neutral',
        localeValue: '中性的',
        locale: 'zh'
      })
    ).toBe('中性')
  })

  it('gives the ko disk-usage heading 저장 공간, matching its own description', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.workspace.space.WorkspaceSpacePage.45f6302dbc',
        enValue: 'Space',
        localeValue: 'Space',
        locale: 'ko'
      })
    ).toBe('저장 공간')
  })
})
