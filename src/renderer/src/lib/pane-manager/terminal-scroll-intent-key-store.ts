import type { TerminalScrollIntent, TerminalScrollIntentKey } from './terminal-scroll-intent-types'

// Why: these maps are durable by design — they outlive a pane's transient unmount so a
// remount with the same persisted leaf id restores its pin, which delete-on-dispose would
// defeat. Bound them with an insertion-ordered LRU instead; an active terminal rewrites its
// intent on every scroll, so only closed leaves age out.
const MAX_SCROLL_INTENT_KEYS = 256

const intentByKey = new Map<TerminalScrollIntentKey, TerminalScrollIntent>()
const bindingByKey = new Map<TerminalScrollIntentKey, number>()

// Why: evict both maps together — a key dropped from one but not the other would strand the
// sibling entry forever, which is the leak this bound exists to close.
function evictOldestKeys(): void {
  while (intentByKey.size > MAX_SCROLL_INTENT_KEYS) {
    const oldest = intentByKey.keys().next().value
    if (oldest === undefined) {
      break
    }
    intentByKey.delete(oldest)
    bindingByKey.delete(oldest)
  }
}

export function readScrollIntentByKey(
  key: TerminalScrollIntentKey
): TerminalScrollIntent | undefined {
  return intentByKey.get(key)
}

export function writeScrollIntentByKey(
  key: TerminalScrollIntentKey,
  intent: TerminalScrollIntent
): void {
  // Re-insert so the key moves to the most-recent position (MRU on write).
  intentByKey.delete(key)
  intentByKey.set(key, intent)
  evictOldestKeys()
}

export function readScrollIntentBindingByKey(key: TerminalScrollIntentKey): number | undefined {
  return bindingByKey.get(key)
}

export function writeScrollIntentBindingByKey(key: TerminalScrollIntentKey, binding: number): void {
  bindingByKey.set(key, binding)
  evictOldestKeys()
}
