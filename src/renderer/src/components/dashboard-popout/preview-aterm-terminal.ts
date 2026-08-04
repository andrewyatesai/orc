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
import {
  normalizeTerminalFastScrollSensitivity,
  normalizeTerminalScrollSensitivity
} from '@/lib/pane-manager/pane-terminal-options'
import { normalizeTerminalTuiMouseWheelMultiplier } from '@/lib/pane-manager/pane-terminal-tui-wheel-reports'
import { resolveTerminalLigaturesEnabled } from '../../../../shared/terminal-ligatures'
import { resolveCursorAgentImeAnchor } from '@/lib/pane-manager/terminal-ime-anchor'
import type { ITheme } from '@/lib/pane-manager/aterm/terminal-types'
import type { GlobalSettings } from '../../../../shared/types'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import { useAppStore } from '@/store'
import { buildPreviewTerminalOptions } from './preview-terminal-options'

const PREVIEW_SCROLLBACK_LIMIT = 1000

/** terminalCursorStyle + terminalCursorBlink as a DECSCUSR param (block 1/2,
 *  underline 3/4, bar 5/6) — the engine's default cursor shape. */
function previewCursorStyleParam(facade: AtermTerminalFacade): number {
  const style = facade.options.cursorStyle
  const base = style === 'bar' ? 5 : style === 'underline' ? 3 : 1
  return facade.options.cursorBlink === false ? base + 1 : base
}

/**
 * The dashboard popout preview's aterm terminal, split in two because the engine
 * build is async: the facade exists immediately and buffers every replayed byte,
 * and the controller (wasm + fonts) attaches behind it a beat later. AgentTerminalPreview
 * owns the PTY stream; this owns the fork's renderer seam.
 */
export function createPreviewTerminalFacade(args: {
  settings: GlobalSettings | null
  /** Host-input facts for the agent's PTY (ConPTY backend, kitty advertisement). */
  terminalInput: DashboardCardTerminalInput | null
  macOptionIsMeta: boolean
  theme: ITheme | null
  appSurface: 'dark' | 'light'
  cols: number
  rows: number
}): AtermTerminalFacade {
  const facade = createAtermTerminalFacade({
    options: buildPreviewTerminalOptions({
      settings: args.settings,
      terminalInput: args.terminalInput,
      macOptionIsMeta: args.macOptionIsMeta,
      theme: args.theme,
      themeMode: args.appSurface,
      scrollback: PREVIEW_SCROLLBACK_LIMIT
    })
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
      // The one handler installPreviewTerminalKeyHandler registers (copy/paste
      // chords + the IME claim), read live per keydown.
      getCustomKeyEventHandler: () => facade.__customKeyEventHandler,
      // Appearance/behavior read off the facade's options bag (seeded from the
      // user's settings, rewritten live by the appearance sync) so the preview
      // emulator is configured exactly like the pane it mirrors.
      getMacOptionIsMeta: () => facade.options.macOptionIsMeta === true,
      getCursorBlink: () => facade.options.cursorBlink !== false,
      getFontPx: () => facade.options.fontSize ?? ATERM_RENDERER_FONT_PX,
      getLineHeight: () => facade.options.lineHeight ?? 1,
      getCursorStyleParam: () => previewCursorStyleParam(facade),
      getScrollSensitivity: () =>
        normalizeTerminalScrollSensitivity(facade.options.scrollSensitivity),
      getFastScrollSensitivity: () =>
        normalizeTerminalFastScrollSensitivity(facade.options.fastScrollSensitivity),
      // The per-pane kitty policy the card relayed (local Windows ConPTY withholds it).
      getKittyKeyboardEnabled: () => facade.options.vtExtensions?.kittyKeyboard !== false,
      getScrollbackLines: () => facade.options.scrollback ?? PREVIEW_SCROLLBACK_LIMIT,
      // Font face / ligatures / TUI wheel come from the store like a pane's: the
      // engine resolves the raw family+weight itself (set_primary_font), and the
      // facade bag only carries the CSS stack.
      getFontFamily: () => useAppStore.getState().settings?.terminalFontFamily,
      getFontWeight: () => useAppStore.getState().settings?.terminalFontWeight,
      getLigatures: () => {
        const settings = useAppStore.getState().settings
        return resolveTerminalLigaturesEnabled(
          settings?.terminalLigatures ?? 'auto',
          settings?.terminalFontFamily
        )
      },
      getTuiScrollMultiplier: () =>
        normalizeTerminalTuiMouseWheelMultiplier(
          useAppStore.getState().settings?.terminalTuiScrollSensitivity
        ),
      // Agent CLIs (Cursor Agent) draw their prompt while parking the real cursor
      // on a blank row — anchor the OS IME candidate window on the prompt (#7061).
      getImeAnchor: () => {
        const buffer = facade.buffer.active
        const anchor = resolveCursorAgentImeAnchor({
          buffer,
          rows: facade.rows,
          cols: facade.cols,
          cursorX: buffer.cursorX,
          cursorY: buffer.cursorY
        })
        return anchor ? { row: anchor.row, col: anchor.column } : null
      }
    }
  )
  if (args.theme) {
    // The engine seeds its theme from the store; re-apply the dialog's composed
    // theme so the preview matches the pane it mirrors.
    controller.updateTheme(atermThemeColorsFromITheme(args.theme))
  }
  return controller
}
