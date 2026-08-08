/**
 * The Settings ▸ Mode section — the container that wires AppModePane to the
 * store and the runtime.
 *
 * **Why this file exists at all.** An earlier commit registered `app-mode` in
 * the Settings navigation metadata but never rendered a matching section. The
 * metadata feeds both the Settings sidebar and Cmd+J, so a stock CLASSIC user
 * got a "Mode" row that opened a blank content area — and because
 * app-mode-search.ts deliberately carries symptom keywords ("restore", "reset
 * layout", "sidebar missing"), a confused user searching for help was steered
 * straight into it. Registering a nav id without a pane is a Classic regression,
 * which is exactly what a mode is forbidden to cause.
 */

import { useCallback } from 'react'
import AppModePane from './AppModePane'
import { useAppStore } from '@/store'
import { normalizeAppModeId, type AppModeId } from '../../../../shared/app-mode/app-mode-id'

export function AppModeSettingsSection(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const mode = normalizeAppModeId(settings?.appMode)

  const onSelect = useCallback(
    (next: AppModeId) => {
      // Routed through the ordinary settings writer: Store.updateSettings strips
      // appMode out of the durable payload and forwards it to setAppMode, so the
      // sidecar stays the single authority and orca-data.json is untouched.
      void updateSettings({ appMode: next })
    },
    [updateSettings]
  )

  // No IPC for revealing app-mode.json yet; null hides the control rather than
  // offering a button that silently does nothing.

  return (
    <AppModePane
      mode={mode}
      // The lock/env rungs are resolved in main; until the renderer is told
      // which rung won, the safe default is "not locked" — showing a control as
      // read-only when it is not would be its own lie.
      locked={false}
      lockReason={null}
      unrecognizedMode={null}
      onSelect={onSelect}
      onRevealSettingsFile={null}
    />
  )
}
