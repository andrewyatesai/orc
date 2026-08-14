import { useEffect, useState, useSyncExternalStore } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from '@/components/terminal-pane/stale-document-visibility'

// Why the stale-latch term is load-bearing: macOS can wedge document.visibilityState at 'hidden'
// with no further visibilitychange, so a window the user is looking at would park its stream
// forever (same bug class as the field report of 78MB of terminal bytes dropped on visible ptys).
function getWindowVisibleSnapshot(): boolean {
  return isWindowVisible() || isDocumentVisibilityProvenStale()
}

function subscribeWindowVisible(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  // Why: the stale latch flips to proven-visible without emitting a visibilitychange.
  const unregisterStaleRecovery = registerStaleDocumentVisibilityRecovery(onChange)
  return () => {
    document.removeEventListener('visibilitychange', onChange)
    unregisterStaleRecovery()
  }
}

// Avoid renegotiating expensive streams during a quick app-switch round trip.
export const WINDOW_STREAM_PARK_DELAY_MS = 500

export function useWindowStreamVisible(parkDelayMs = WINDOW_STREAM_PARK_DELAY_MS): boolean {
  const rawVisible = useSyncExternalStore(
    subscribeWindowVisible,
    getWindowVisibleSnapshot,
    getWindowVisibleSnapshot
  )
  const [effectiveVisible, setEffectiveVisible] = useState(rawVisible)

  useEffect(() => {
    if (rawVisible) {
      setEffectiveVisible(true)
      return
    }
    const timer = window.setTimeout(() => setEffectiveVisible(false), parkDelayMs)
    return () => window.clearTimeout(timer)
  }, [parkDelayMs, rawVisible])

  return effectiveVisible
}
