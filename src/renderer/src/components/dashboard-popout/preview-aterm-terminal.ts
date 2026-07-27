import {
  createAtermTerminalFacade,
  type AtermTerminalFacade
} from '@/lib/pane-manager/aterm/aterm-terminal-facade'
import {
  createAtermPaneController,
  ATERM_RENDERER_FONT_PX,
  type AtermPaneController
} from '@/lib/pane-manager/aterm/aterm-pane-renderer'
import { atermThemeColorsFromITheme } from '@/lib/pane-manager/aterm/aterm-theme-colors'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { resolveTerminalMinimumContrastRatio } from '@/lib/terminal-contrast-correction'
import type { ITheme } from '@/lib/pane-manager/aterm/terminal-types'

const PREVIEW_SCROLLBACK_LIMIT = 1000

/**
 * The dashboard popout preview's aterm terminal, split in two because the engine
 * build is async: the facade exists immediately and buffers every replayed byte,
 * and the controller (wasm + fonts) attaches behind it a beat later. AgentTerminalPreview
 * owns the PTY stream; this owns the fork's renderer seam.
 */
export function createPreviewTerminalFacade(args: {
  theme: ITheme | null
  appSurface: 'dark' | 'light'
  cols: number
  rows: number
}): AtermTerminalFacade {
  const facade = createAtermTerminalFacade({
    options: {
      ...buildDefaultTerminalOptions(),
      theme: args.theme ?? undefined,
      minimumContrastRatio: resolveTerminalMinimumContrastRatio(
        args.theme?.background,
        args.appSurface
      ),
      scrollback: PREVIEW_SCROLLBACK_LIMIT
    }
  })
  // Pre-attach the facade holds this and applies it to the engine BEFORE the
  // buffered replay lands, so the frame parses in the PTY's real grid.
  facade.resize(args.cols, args.rows)
  return facade
}

/** Build the engine behind an already-live preview facade. */
export async function createPreviewAtermController(args: {
  container: HTMLElement
  facade: AtermTerminalFacade
  theme: ITheme | null
  /** Engine-sourced PTY bytes: real gestures AND the emulator's auto-replies. */
  onEngineInput: (data: string) => void
}): Promise<AtermPaneController> {
  const { facade } = args
  const controller = await createAtermPaneController(
    args.container,
    args.onEngineInput,
    // The dialog negotiates the PTY grid through terminalPreview.fit
    // (createPreviewGridClaim), never from the engine's own grid commits.
    () => undefined,
    (text) => facade.paste(text),
    undefined,
    {
      // The one handler installPreviewClipboardShortcuts registers (copy/paste
      // chords + the IME claim), read live per keydown.
      getCustomKeyEventHandler: () => facade.__customKeyEventHandler,
      getMacOptionIsMeta: () => facade.options.macOptionIsMeta === true,
      getCursorBlink: () => facade.options.cursorBlink !== false,
      getFontPx: () => facade.options.fontSize ?? ATERM_RENDERER_FONT_PX,
      getScrollbackLines: () => facade.options.scrollback ?? PREVIEW_SCROLLBACK_LIMIT
    }
  )
  if (args.theme) {
    // The engine seeds its theme from the store; re-apply the dialog's composed
    // theme so the preview matches the pane it mirrors.
    controller.updateTheme(atermThemeColorsFromITheme(args.theme))
  }
  return controller
}
