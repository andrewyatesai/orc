import { describe, expect, it } from 'vitest'
import { copyUtf16SuffixToOwnedString } from './owned-utf16-suffix'

describe('copyUtf16SuffixToOwnedString', () => {
  it('copies a suffix that spans many copy blocks byte-for-byte', () => {
    // Well past the 4Ki copy-block size so the block loop runs multiple passes.
    const value = 'A'.repeat(10) + 'B'.repeat(20 * 1024)
    const suffix = 20 * 1024

    const owned = copyUtf16SuffixToOwnedString(value, suffix)

    expect(owned).toBe(value.slice(value.length - suffix))
    expect(owned).toHaveLength(suffix)
  })

  it('preserves lone surrogate code units on the suffix boundary', () => {
    const value = `prefix\ud83d${'x'.repeat(5000)}\ude00`

    const owned = copyUtf16SuffixToOwnedString(value, value.length - 'prefix'.length)

    expect(owned).toBe(value.slice('prefix'.length))
    expect(owned.charCodeAt(0)).toBe(0xd83d)
    expect(owned.charCodeAt(owned.length - 1)).toBe(0xde00)
  })

  it('clamps an over-long request to the whole string and empty on zero', () => {
    expect(copyUtf16SuffixToOwnedString('short', 999)).toBe('short')
    expect(copyUtf16SuffixToOwnedString('short', 0)).toBe('')
    expect(copyUtf16SuffixToOwnedString('short', -5)).toBe('')
  })
})
