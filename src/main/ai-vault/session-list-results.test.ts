import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { mergeAiVaultListResults } from './session-list-results'

function listResult(scannedAt: string): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt }
}

describe('mergeAiVaultListResults scannedAt', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the latest input scannedAt instead of restamping the merge', () => {
    const merged = mergeAiVaultListResults(
      [listResult('2026-08-02T00:00:00.000Z'), listResult('2026-08-02T00:00:05.000Z')],
      undefined
    )

    expect(merged.scannedAt).toBe('2026-08-02T00:00:05.000Z')
  })

  it('ignores a future or unparsable remote stamp so the merge cannot pin the renderer guard', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T00:00:10.000Z'))

    // A remote leg whose clock is ahead is ignored so it cannot freeze the guard.
    expect(
      mergeAiVaultListResults(
        [listResult('2026-08-02T00:00:20.000Z'), listResult('2026-08-02T00:00:05.000Z')],
        undefined
      ).scannedAt
    ).toBe('2026-08-02T00:00:05.000Z')

    // A non-ISO stamp is unparsable, so the real local rescan wins.
    expect(
      mergeAiVaultListResults(
        [listResult('scan-A'), listResult('2026-08-02T00:00:04.000Z')],
        undefined
      ).scannedAt
    ).toBe('2026-08-02T00:00:04.000Z')

    // Every leg unusable falls back to now, never a frozen stamp.
    expect(mergeAiVaultListResults([listResult('scan-A')], undefined).scannedAt).toBe(
      '2026-08-02T00:00:10.000Z'
    )
  })
})
