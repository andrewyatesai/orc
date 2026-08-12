import type { WindowsShiftEnterEncoding } from './terminal-windows-shift-enter'

// Re-exported so the shortcut policy types getWindowsShiftEnterEncoding from a single import source.
export type { WindowsShiftEnterEncoding }

/**
 * Ctrl+Enter bytes for a pane that has NOT negotiated the kitty keyboard protocol. CSI-u
 * (\x1b[13;5u, modifier 5 = Ctrl) lets TUIs distinguish Ctrl+Enter from a bare CR, so remote/WSL and
 * non-Windows panes forward it. But a local Windows ConPTY shell that never negotiated kitty prints
 * the escape verbatim into the prompt (#12329), so fall back there to the legacy CR — unless a trusted
 * Windows agent (e.g. Droid) opted into CSI-u out-of-band, mirroring the Shift+Enter guard.
 */
export function resolveCtrlEnterAction(
  isLocalWindowsConptyPane?: () => boolean,
  getWindowsShiftEnterEncoding?: () => WindowsShiftEnterEncoding
): { type: 'sendInput'; data: string } {
  const canSendCsiU =
    isLocalWindowsConptyPane?.() !== true || getWindowsShiftEnterEncoding?.() === 'csi-u'
  return { type: 'sendInput', data: canSendCsiU ? '\x1b[13;5u' : '\r' }
}
