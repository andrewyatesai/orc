import type { GlobalSettings } from '../../../../shared/types'

/**
 * TTL (ms) for a card's aggregate prompt-cache timer.
 *
 * Derived from the `settings` the card already subscribes to — deliberately NOT its
 * own useAppStore subscription. Reading promptCacheTtlMs through the store would add
 * a third listener per card that fires on every unrelated store write (see #13903).
 */
export function useWorktreeCardCacheTtlMs(
  settings: GlobalSettings | null | undefined,
  showAggregateCacheTimer: boolean
): number {
  return showAggregateCacheTimer ? (settings?.promptCacheTtlMs ?? 0) : 0
}
