import type { AtermTerminalFacade } from '@/lib/pane-manager/aterm/aterm-terminal-facade'
import type { AtermPaneController } from '@/lib/pane-manager/aterm/aterm-pane-renderer'

/** The terminal reads the fit needs: grid rows and the live cursor row. */
type PreviewFitTerminal = Pick<AtermTerminalFacade, 'rows' | 'buffer'>

/**
 * Scales the popout preview's terminal frame into the dialog box. The terminal
 * always renders at the PTY's REAL grid (serialized ANSI replayed into other
 * dimensions rewraps into garbage), so when the frame is bigger than the box it
 * is scaled down and anchored at whichever end keeps the cursor visible.
 */
export function createPreviewFrameFit(
  container: HTMLElement,
  getTerminal: () => PreviewFitTerminal | null
): { fit: () => void; schedule: () => void } {
  let scheduled = false

  const fit = (): void => {
    const terminal = getTerminal()
    const screen = container.querySelector<HTMLElement>('.xterm-screen')
    const box = container.parentElement
    if (!screen || !box || !terminal) {
      return
    }
    const scale = Math.min(1, box.clientWidth / Math.max(1, screen.offsetWidth))
    container.style.transform = scale < 1 ? `scale(${scale})` : ''
    // Anchor whichever end keeps the CURSOR row in view when the terminal is
    // taller than the box: a fresh shell prompts at the TOP of its screen
    // (blind bottom-anchoring clipped it away), while a busy TUI keeps its
    // action at the bottom.
    const cellHeight = screen.offsetHeight / Math.max(1, terminal.rows)
    const cursorBottom = (terminal.buffer.active.cursorY + 1) * cellHeight * scale
    const anchorTop = cursorBottom <= box.clientHeight
    box.style.alignItems = anchorTop ? 'flex-start' : 'flex-end'
    container.style.transformOrigin = anchorTop ? 'top left' : 'bottom left'
  }

  return {
    fit,
    // Re-fit after every parsed write (cursor may move ends); rAF coalesces.
    schedule: (): void => {
      if (scheduled) {
        return
      }
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        fit()
      })
    }
  }
}

/**
 * Size the preview's box to the grid's natural pixel footprint. aterm's canvas
 * fills its container, so rendering at the PTY's real cols/rows means giving the
 * container that size — xterm's DOM renderer used to lay `.xterm-screen` out for
 * itself.
 */
export function sizePreviewContainerToGrid(
  container: HTMLElement,
  terminal: Pick<AtermTerminalFacade, 'cols' | 'rows'> | null,
  controller: Pick<AtermPaneController, 'cellSizeCss'> | null
): void {
  const cell = controller?.cellSizeCss()
  if (!terminal || !cell || cell.width <= 0 || cell.height <= 0) {
    return
  }
  container.style.width = `${Math.round(terminal.cols * cell.width)}px`
  container.style.height = `${Math.round(terminal.rows * cell.height)}px`
}
