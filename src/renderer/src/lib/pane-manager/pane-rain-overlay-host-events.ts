import type { IDisposable, Terminal } from '@xterm/xterm'

type RainOverlayHostEventOptions = {
  readonly terminal: Terminal
  readonly xtermContainer: HTMLElement
  readonly onWriteParsed: () => void
  readonly onSnapshotChange: () => void
  readonly onGeometryChange: () => void
  readonly onVisibilityChange: (focused: boolean) => void
  readonly onIntersectionChange: (visible: boolean) => void
}

/** Owns browser/xterm subscriptions while an enabled overlay may be resumed. */
export function attachRainOverlayHostEvents(options: RainOverlayHostEventOptions): () => void {
  const disposables: IDisposable[] = [
    options.terminal.onWriteParsed(options.onWriteParsed),
    options.terminal.onResize(options.onGeometryChange),
    options.terminal.onScroll(options.onSnapshotChange)
  ]
  const handleVisibilityChange = (): void => {
    options.onVisibilityChange(document.visibilityState !== 'hidden' && document.hasFocus())
  }
  const handleFocus = (): void => options.onVisibilityChange(true)
  const handleBlur = (): void => options.onVisibilityChange(false)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('focus', handleFocus)
  window.addEventListener('blur', handleBlur)
  window.addEventListener('resize', options.onGeometryChange)

  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(options.onGeometryChange)
  resizeObserver?.observe(options.xtermContainer)
  const screen = options.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (screen) {
    resizeObserver?.observe(screen)
  }
  const intersectionObserver =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => {
          options.onIntersectionChange(entries.some((entry) => entry.isIntersecting))
        })
  intersectionObserver?.observe(options.xtermContainer)

  return () => {
    for (const disposable of disposables) {
      disposable.dispose()
    }
    resizeObserver?.disconnect()
    intersectionObserver?.disconnect()
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('focus', handleFocus)
    window.removeEventListener('blur', handleBlur)
    window.removeEventListener('resize', options.onGeometryChange)
  }
}
