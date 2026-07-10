import type { Terminal } from '@xterm/xterm'

import type { RainOverlayViewport } from './pane-rain-overlay-types'

export type RainOverlayGeometry = RainOverlayViewport & {
  readonly left: number
  readonly top: number
}

export function createRainOverlayCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.className = 'aterm-rain-overlay'
  canvas.hidden = true
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: '3',
    background: 'transparent'
  })
  return canvas
}

export function rainOverlayGeometryEquals(
  a: RainOverlayGeometry | null,
  b: RainOverlayGeometry
): boolean {
  return (
    a?.left === b.left &&
    a.top === b.top &&
    a.cssWidth === b.cssWidth &&
    a.cssHeight === b.cssHeight &&
    a.pixelWidth === b.pixelWidth &&
    a.pixelHeight === b.pixelHeight &&
    a.devicePixelRatio === b.devicePixelRatio &&
    a.cellWidth === b.cellWidth &&
    a.cellHeight === b.cellHeight
  )
}

export function readRainOverlayGeometry(
  terminal: Terminal,
  xtermContainer: HTMLElement
): RainOverlayGeometry | null {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen || !xtermContainer.isConnected) {
    return null
  }
  const screenRect = screen.getBoundingClientRect()
  const hostRect = xtermContainer.getBoundingClientRect()
  if (!(screenRect.width > 0) || !(screenRect.height > 0)) {
    return null
  }
  const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1)
  return {
    left: screenRect.left - hostRect.left,
    top: screenRect.top - hostRect.top,
    cssWidth: screenRect.width,
    cssHeight: screenRect.height,
    pixelWidth: Math.max(1, Math.round(screenRect.width * devicePixelRatio)),
    pixelHeight: Math.max(1, Math.round(screenRect.height * devicePixelRatio)),
    devicePixelRatio,
    cellWidth: screenRect.width / terminal.cols,
    cellHeight: screenRect.height / terminal.rows
  }
}
