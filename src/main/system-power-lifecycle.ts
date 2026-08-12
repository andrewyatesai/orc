export type SystemPowerLifecycleListener = {
  onSuspend: () => void
  onResume: () => void
}

type SystemPowerState = 'awake' | 'suspended'

const listeners = new Set<SystemPowerLifecycleListener>()
let state: SystemPowerState = 'awake'

function notifyListener(listener: SystemPowerLifecycleListener, nextState: SystemPowerState): void {
  try {
    if (nextState === 'suspended') {
      listener.onSuspend()
    } else {
      listener.onResume()
    }
  } catch (error) {
    console.error('[power] System lifecycle listener failed:', error)
  }
}

// Why: replay current state to a late subscriber so a stream that subscribes after
// suspend already fired sees the suspended state, not a stale 'awake'.
export function subscribeSystemPowerLifecycle(listener: SystemPowerLifecycleListener): () => void {
  listeners.add(listener)
  notifyListener(listener, state)
  return () => listeners.delete(listener)
}

export function publishSystemSuspend(): void {
  state = 'suspended'
  // Why: snapshot + membership recheck so a listener added/removed mid-fanout
  // neither misses the transition nor fires after it unsubscribed.
  for (const listener of Array.from(listeners)) {
    if (listeners.has(listener)) {
      notifyListener(listener, state)
    }
  }
}

export function publishSystemResume(): void {
  state = 'awake'
  for (const listener of Array.from(listeners)) {
    if (listeners.has(listener)) {
      notifyListener(listener, state)
    }
  }
}
