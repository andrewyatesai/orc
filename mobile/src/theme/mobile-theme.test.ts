import { describe, expect, it } from 'vitest'
import { colors } from './mobile-theme'

// WCAG 2.1 relative luminance + contrast ratio, computed from the SHIPPED
// `colors` export so a regression to a dimmer token is caught at the seam.
const channel = (c: number): number => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16)
  const r = channel((n >> 16) & 0xff)
  const g = channel((n >> 8) & 0xff)
  const b = channel(n & 0xff)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (fg: string, bg: string): number => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

describe('secondary/muted text contrast (#11651)', () => {
  // The old #555555 muted token cleared only ~2.5:1 on bgBase and read as
  // near-invisible chrome; both dim tokens must now meet WCAG AA (4.5:1).
  it('textSecondary and textMuted meet AA against bgBase', () => {
    expect(contrast(colors.textSecondary, colors.bgBase)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(colors.textMuted, colors.bgBase)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps the secondary/muted hierarchy (secondary at least as bright)', () => {
    expect(luminance(colors.textSecondary)).toBeGreaterThanOrEqual(luminance(colors.textMuted))
    expect(luminance(colors.textPrimary)).toBeGreaterThan(luminance(colors.textSecondary))
  })

  it('carries the upstream contrast-fix values', () => {
    expect(colors.textSecondary).toBe('#a1a1a1')
    expect(colors.textMuted).toBe('#8c8c8c')
  })
})
