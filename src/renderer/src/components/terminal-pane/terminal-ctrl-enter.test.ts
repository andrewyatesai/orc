import { describe, expect, it, vi } from 'vitest'
import { resolveCtrlEnterAction } from './terminal-ctrl-enter'

const CSI_U = { type: 'sendInput', data: '\x1b[13;5u' } as const
const CR = { type: 'sendInput', data: '\r' } as const

describe('resolveCtrlEnterAction', () => {
  it('forwards CSI-u for any pane that is not a local Windows ConPTY (TUI case)', () => {
    // macOS/Linux/remote/WSL panes pass no ConPTY probe, so probing TUIs still get the distinct chord.
    expect(resolveCtrlEnterAction()).toEqual(CSI_U)
    expect(resolveCtrlEnterAction(() => false)).toEqual(CSI_U)
    expect(
      resolveCtrlEnterAction(
        () => false,
        () => 'alt-enter'
      )
    ).toEqual(CSI_U)
  })

  it('degrades to a bare CR on an un-negotiated local Windows ConPTY (#12329)', () => {
    // Without CSI-u negotiation the escape would print verbatim into the PSReadLine prompt.
    expect(resolveCtrlEnterAction(() => true)).toEqual(CR)
    expect(
      resolveCtrlEnterAction(
        () => true,
        () => 'alt-enter'
      )
    ).toEqual(CR)
  })

  it('keeps CSI-u on a local ConPTY whose trusted agent negotiated it', () => {
    // Query-only agents (e.g. Droid) parse CSI-u directly even while the live kitty flags stay inactive.
    expect(
      resolveCtrlEnterAction(
        () => true,
        () => 'csi-u'
      )
    ).toEqual(CSI_U)
  })

  it('never consults the agent encoding for a non-ConPTY pane (stays lazy)', () => {
    const getWindowsShiftEnterEncoding = vi.fn(() => 'csi-u' as const)
    expect(resolveCtrlEnterAction(() => false, getWindowsShiftEnterEncoding)).toEqual(CSI_U)
    expect(getWindowsShiftEnterEncoding).not.toHaveBeenCalled()
  })
})
