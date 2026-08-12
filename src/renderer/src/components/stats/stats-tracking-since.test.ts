import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIntlLocale } = vi.hoisted(() => ({ mockIntlLocale: { value: 'en-US' } }))

vi.mock('@/i18n/i18n', () => ({ getIntlLocale: () => mockIntlLocale.value }))

import { formatTrackingSince } from './stats-tracking-since'

// UTC noon so the local-timezone day never straddles a date boundary between locales.
const TIMESTAMP = Date.UTC(2026, 4, 3, 12)

beforeEach(() => {
  mockIntlLocale.value = 'en-US'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('formatTrackingSince', () => {
  it('returns an empty string when there is no timestamp', () => {
    expect(formatTrackingSince(null)).toBe('')
    expect(formatTrackingSince(0)).toBe('')
  })

  it('formats the date with the selected UI language, not the OS locale', () => {
    // The bug (#12105): passing `undefined` here silently formats with the OS locale.
    const spy = vi.spyOn(Date.prototype, 'toLocaleDateString')
    mockIntlLocale.value = 'ja'
    formatTrackingSince(TIMESTAMP)
    expect(spy.mock.calls[0]?.[0]).toBe('ja')
  })

  it('renders a different date shape when the UI language changes', () => {
    mockIntlLocale.value = 'en-US'
    const english = formatTrackingSince(TIMESTAMP)
    mockIntlLocale.value = 'ja'
    const japanese = formatTrackingSince(TIMESTAMP)
    expect(japanese).not.toBe(english)
  })
})
