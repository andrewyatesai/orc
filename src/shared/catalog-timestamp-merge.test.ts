import { describe, expect, it } from 'vitest'
import {
  catalogTimestampFromAddedAt,
  mergeCatalogCreatedAt,
  mergeCatalogUpdatedAt
} from './catalog-timestamp-merge'

describe('catalog timestamp merge', () => {
  it('normalizes 0 / NaN addedAt to a stable 0 instead of Date.now()', () => {
    expect(catalogTimestampFromAddedAt(100)).toBe(100)
    expect(catalogTimestampFromAddedAt(0)).toBe(0)
    expect(catalogTimestampFromAddedAt(Number.NaN)).toBe(0)
    expect(catalogTimestampFromAddedAt(undefined as unknown as number)).toBe(0)
  })

  it('picks the known createdAt regardless of which side is the unknown 0', () => {
    expect(mergeCatalogCreatedAt(0, 100)).toBe(100)
    expect(mergeCatalogCreatedAt(100, 0)).toBe(100)
    expect(mergeCatalogCreatedAt(100, 200)).toBe(100)
    expect(mergeCatalogCreatedAt(0, 0)).toBe(0)
  })

  it('picks the known updatedAt regardless of which side is the unknown 0', () => {
    expect(mergeCatalogUpdatedAt(0, 100)).toBe(100)
    expect(mergeCatalogUpdatedAt(100, 0)).toBe(100)
    expect(mergeCatalogUpdatedAt(100, 200)).toBe(200)
    expect(mergeCatalogUpdatedAt(0, 0)).toBe(0)
  })
})
