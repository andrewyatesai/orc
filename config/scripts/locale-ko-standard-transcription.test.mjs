import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

// Guards the shipped Korean catalog against regressing the standard loanword
// transcription + terminology fixes (upstream #8816 cherry-picked subset).
// Reads the production ko.json so a stale form in the real catalog fails here.

function flattenLeaves(value, out = []) {
  if (typeof value === 'string') {
    out.push(value)
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      flattenLeaves(child, out)
    }
  }
  return out
}

const catalog = JSON.parse(
  fs.readFileSync(new URL('../../src/renderer/src/i18n/locales/ko.json', import.meta.url), 'utf8')
)
const leaves = flattenLeaves(catalog)

describe('locale ko standard transcription', () => {
  it('renders the directory loanword as 디렉터리, never 디렉토리', () => {
    expect(leaves.filter((leaf) => leaf.includes('디렉토리'))).toEqual([])
  })

  it('keeps only the intended standalone 쉘, standardizing labels to 셸', () => {
    // Upstream leaves exactly one 쉘 (the symlink-removal string); every
    // shell label was transcribed to 셸.
    const withOldShell = leaves.filter((leaf) => leaf.includes('쉘'))
    expect(withOldShell).toHaveLength(1)
    expect(withOldShell[0]).toContain('심볼릭 링크')
  })

  it('rejects comments as 너무 길어, not 너무 커서', () => {
    // The commentTooLarge string ends in "안전하게 제출할 수 없습니다"; the
    // diff/env "too large" strings use 파싱/표시 and are intentionally kept.
    const commentLeaves = leaves.filter((leaf) => leaf.includes('안전하게 제출할 수 없습니다'))
    expect(commentLeaves.length).toBeGreaterThan(0)
    for (const leaf of commentLeaves) {
      expect(leaf).toContain('너무 길어')
      expect(leaf).not.toContain('너무 커서')
    }
  })

  it('uses the standardized terminology for milestone, permission, and privacy', () => {
    expect(leaves).toContain('마일스톤')
    expect(leaves).not.toContain('이정표')

    expect(leaves.some((leaf) => leaf.includes('권한이 허용되었습니다'))).toBe(true)
    expect(leaves.some((leaf) => leaf.includes('허가가 부여'))).toBe(false)

    expect(leaves.some((leaf) => leaf.includes('개인정보 보호 환경 안에서 실행됩니다'))).toBe(true)
    expect(leaves.some((leaf) => leaf.includes('봉투'))).toBe(false)
  })
})
