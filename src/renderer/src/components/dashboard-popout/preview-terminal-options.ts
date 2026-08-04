import type { ITerminalOptions, ITheme } from '@/lib/pane-manager/aterm/terminal-types'
import type { GlobalSettings } from '../../../../shared/types'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import { resolveTerminalFontWeights } from '@/lib/git-wasm/terminal-fonts'
import { normalizeTerminalLineHeight } from '../../../../shared/terminal-line-height-settings'
import {
  buildDefaultTerminalOptions,
  normalizeTerminalFastScrollSensitivity,
  normalizeTerminalScrollSensitivity,
  resolveTerminalCursorInactiveStyle
} from '@/lib/pane-manager/pane-terminal-options'
import { buildLocalConptyTerminalOptions } from '@/lib/pane-manager/windows-pty-compatibility'
import { buildFontFamily } from '@/components/terminal-pane/layout-serialization'
import { resolveTerminalMinimumContrastRatio } from '@/lib/terminal-contrast-correction'

/** Options a live settings change can write onto an open preview terminal. The
 *  aterm controller reads them off the facade's bag live (see
 *  createPreviewAtermController), exactly as applyTerminalAppearance does for a
 *  pane. terminalWordSeparator is absent on purpose: the engine reads it straight
 *  from the store (getWordSeparators), so a per-terminal copy would be dead. */
export function buildPreviewAppearanceOptions(
  settings: GlobalSettings | null,
  macOptionIsMeta: boolean
): Partial<ITerminalOptions> {
  const cursorStyle = settings?.terminalCursorStyle ?? 'block'
  const fontWeights = resolveTerminalFontWeights(settings?.terminalFontWeight)
  return {
    fontSize: settings?.terminalFontSize ?? 14,
    fontFamily: buildFontFamily(settings?.terminalFontFamily ?? ''),
    fontWeight: fontWeights.fontWeight,
    fontWeightBold: fontWeights.fontWeightBold,
    cursorStyle,
    cursorInactiveStyle: resolveTerminalCursorInactiveStyle(cursorStyle),
    cursorBlink: settings?.terminalCursorBlink ?? true,
    scrollSensitivity: normalizeTerminalScrollSensitivity(settings?.terminalScrollSensitivity),
    fastScrollSensitivity: normalizeTerminalFastScrollSensitivity(
      settings?.terminalFastScrollSensitivity
    ),
    lineHeight: normalizeTerminalLineHeight(settings?.terminalLineHeight),
    // Why only 'true': 'left'/'right' are handled by the keydown policy, which needs Option composable at the engine level.
    macOptionIsMeta
    // allowTransparency is deliberately absent (parity with applyTerminalAppearance):
    // aterm applies terminalBackgroundOpacity itself via set_background_opacity.
  }
}

/**
 * Full option set for the preview's terminal: the same defaults, user appearance,
 * and host compatibility flags a pane resolves, so the agent's TUI negotiates
 * with an identically-configured emulator. Scrollback stays preview-sized —
 * main only ever serializes a short history window into this terminal. The grid
 * is NOT set here: the facade sizes it through resize() at the PTY's real dims.
 */
export function buildPreviewTerminalOptions(args: {
  settings: GlobalSettings | null
  terminalInput: DashboardCardTerminalInput | null
  macOptionIsMeta: boolean
  theme: ITheme | null
  themeMode: 'dark' | 'light'
  scrollback: number
}): ITerminalOptions {
  const hostCompatibility: Partial<ITerminalOptions> = {
    ...(args.terminalInput?.localWindowsConpty
      ? buildLocalConptyTerminalOptions(args.terminalInput.osRelease)
      : {}),
    // Why: local ConPTY CLIs read the advertisement but can't decode CSI-u (#2434); mirror the pane's withhold.
    ...(args.terminalInput && !args.terminalInput.kittyKeyboardAdvertised
      ? { vtExtensions: { kittyKeyboard: false } }
      : {})
  }
  return {
    ...buildDefaultTerminalOptions(),
    ...buildPreviewAppearanceOptions(args.settings, args.macOptionIsMeta),
    ...hostCompatibility,
    scrollback: args.scrollback,
    theme: args.theme ?? undefined,
    minimumContrastRatio: resolveTerminalMinimumContrastRatio(
      args.theme?.background,
      args.themeMode
    )
  }
}
