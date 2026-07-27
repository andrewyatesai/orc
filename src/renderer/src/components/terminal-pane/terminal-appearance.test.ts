import { describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  applyTerminalAppearance,
  publishTerminalViewAttributesAtAppStart
} from './terminal-appearance'
import { maybePushMode2031Flip } from './terminal-mode-2031-replies'
import { mode2031SequenceFor } from '../../../../shared/terminal-color-scheme-protocol'
import { _resetTerminalViewAttributesPublisherForTest } from './terminal-view-attributes-publisher'
import type { TerminalViewAttributes } from '../../../../shared/terminal-view-attributes'

function fakeTransport(overrides?: { connected?: boolean; sendOk?: boolean }): {
  isConnected: () => boolean
  sendInput: ReturnType<typeof vi.fn<(data: string) => boolean>>
  sendInputImmediate: ReturnType<typeof vi.fn<(data: string) => boolean>>
} {
  const connected = overrides?.connected ?? true
  const sendOk = overrides?.sendOk ?? true
  return {
    isConnected: () => connected,
    sendInput: vi.fn<(data: string) => boolean>(() => sendOk),
    sendInputImmediate: vi.fn<(data: string) => boolean>(() => sendOk)
  }
}

describe('mode2031SequenceFor', () => {
  it('maps dark to CSI ?997;1n and light to CSI ?997;2n', () => {
    expect(mode2031SequenceFor('dark')).toBe('\x1b[?997;1n')
    expect(mode2031SequenceFor('light')).toBe('\x1b[?997;2n')
  })
})

describe('maybePushMode2031Flip', () => {
  it('does nothing when the pane has not subscribed to mode 2031', () => {
    const transport = fakeTransport()
    const subs = new Map<number, boolean>()
    const last = new Map<number, 'dark' | 'light'>()

    const pushed = maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(pushed).toBe(false)
    expect(transport.sendInputImmediate).not.toHaveBeenCalled()
    expect(last.has(1)).toBe(false)
  })

  it('pushes the current mode once after subscribe and records it', () => {
    const transport = fakeTransport()
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    const pushed = maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(pushed).toBe(true)
    // Routes through the latency-critical path so the reply lands before the
    // shell regains input (fish/remote batching), never the batched sendInput.
    expect(transport.sendInputImmediate).toHaveBeenCalledTimes(1)
    expect(transport.sendInputImmediate).toHaveBeenCalledWith('\x1b[?997;1n')
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(last.get(1)).toBe('dark')
  })

  it('suppresses repeat pushes when the resolved mode has not changed', () => {
    // Spam-gate: applyTerminalAppearance re-runs on every font/opacity/cursor tweak; don't emit CSI 997 each time.
    const transport = fakeTransport()
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    maybePushMode2031Flip(1, 'dark', transport, subs, last)
    maybePushMode2031Flip(1, 'dark', transport, subs, last)
    maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(transport.sendInputImmediate).toHaveBeenCalledTimes(1)
    expect(last.get(1)).toBe('dark')
  })

  it('emits again when the theme actually flips', () => {
    const transport = fakeTransport()
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    maybePushMode2031Flip(1, 'dark', transport, subs, last)
    maybePushMode2031Flip(1, 'light', transport, subs, last)
    maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(transport.sendInputImmediate.mock.calls.map((c) => c[0])).toEqual([
      '\x1b[?997;1n',
      '\x1b[?997;2n',
      '\x1b[?997;1n'
    ])
    expect(last.get(1)).toBe('dark')
  })

  it('does not push when the transport is disconnected', () => {
    const transport = fakeTransport({ connected: false })
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    const pushed = maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(pushed).toBe(false)
    expect(transport.sendInputImmediate).not.toHaveBeenCalled()
    expect(last.has(1)).toBe(false)
  })

  it('leaves last-mode untouched when immediate input reports failure', () => {
    // So a reconnect / retry will re-emit on the next appearance pass.
    const transport = fakeTransport({ sendOk: false })
    const subs = new Map([[1, true]])
    const last = new Map<number, 'dark' | 'light'>()

    const pushed = maybePushMode2031Flip(1, 'dark', transport, subs, last)

    expect(pushed).toBe(false)
    expect(transport.sendInputImmediate).toHaveBeenCalledTimes(1)
    expect(last.has(1)).toBe(false)
  })

  it('tracks flip state per-pane', () => {
    const transportA = fakeTransport()
    const transportB = fakeTransport()
    const subs = new Map([
      [1, true],
      [2, true]
    ])
    const last = new Map<number, 'dark' | 'light'>()

    maybePushMode2031Flip(1, 'dark', transportA, subs, last)
    maybePushMode2031Flip(2, 'light', transportB, subs, last)
    maybePushMode2031Flip(1, 'dark', transportA, subs, last) // suppressed
    maybePushMode2031Flip(2, 'dark', transportB, subs, last) // flip

    expect(transportA.sendInputImmediate).toHaveBeenCalledTimes(1)
    expect(transportB.sendInputImmediate).toHaveBeenCalledTimes(2)
    expect(last.get(1)).toBe('dark')
    expect(last.get(2)).toBe('dark')
  })
})

// The renderer-side CSI mode-2031 handlers (installMode2031Handlers) are inert
// under aterm: the facade parser no-ops registerCsiHandler (see
// aterm-facade-parser.ts), so `CSI ?2031h/l` never reaches them. The real
// subscribe/reply behavior — recognizing mode 2031 and pushing the current
// color scheme — is handled natively by the aterm wasm engine and covered by
// the aterm e2e specs (tests/e2e/terminal-tab-switch-visual-restore.spec.ts via
// hiddenRendererMode2031ReplyCount), which run against the real engine + PTY.
// The pure spam-gate logic the renderer still owns (maybePushMode2031Flip) is
// covered above without an xterm parser.

describe('applyTerminalAppearance theme assignment', () => {
  // Value-gated assignment: re-theming calls atermController.updateTheme, which rebuilds the engine palette and would
  // discard a TUI's OSC 4/10/11/12 mutations; skipping value-identical composes keeps those mutations alive.
  function makePane(id: number): ManagedPane {
    return { id, terminal: { options: {}, cols: 80, rows: 24 } } as unknown as ManagedPane
  }

  function makeManager(panes: ManagedPane[]): PaneManager {
    return {
      getPanes: () => panes,
      setPaneLigaturesEnabled: vi.fn(),
      setPaneStyleOptions: vi.fn()
    } as unknown as PaneManager
  }

  function apply(pane: ManagedPane, settings: ReturnType<typeof getDefaultSettings>): void {
    applyTerminalAppearance(
      makeManager([pane]),
      settings,
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
  }

  it('keeps options.theme identity across attribute-neutral applies (font size tweak)', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, settings)
    const firstTheme = pane.terminal.options.theme
    expect(firstTheme).toBeDefined()

    apply(pane, { ...settings, terminalFontSize: settings.terminalFontSize + 2 })

    // Identity-stable theme means the pane is never re-themed, so a TUI's modifyColors mutation survives the font tweak.
    expect(pane.terminal.options.theme).toBe(firstTheme)
    expect(pane.terminal.options.fontSize).toBe(settings.terminalFontSize + 2)
  })

  it('still assigns a fresh theme when composed values actually change', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, settings)
    const firstTheme = pane.terminal.options.theme

    apply(pane, { ...settings, terminalColorOverrides: { background: '#102030' } })

    expect(pane.terminal.options.theme).not.toBe(firstTheme)
    expect(pane.terminal.options.theme?.background).toBe('#102030')
  })

  // #7934: contrast correction rescues invisible white text on light backgrounds but over-corrects on dark;
  // gate by the composed theme's background luminance (either theme slot can hold either kind of theme).
  it('keeps xterm contrast correction on light themes', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'light' })

    expect(pane.terminal.options.minimumContrastRatio).toBe(4.5)
  })

  it('applies the mild dark-background contrast floor on dark themes', () => {
    // #10104: a floor of 3 rescues near-background body text (e.g. Antigravity's #262b30 on #1e242a)
    // without the 4.5-floor over-brightening of vibrant ANSI colors that #7934 fixed.
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'dark' })

    expect(pane.terminal.options.minimumContrastRatio).toBe(3)
  })

  it('re-gates contrast correction when the theme flips live', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'light' })
    expect(pane.terminal.options.minimumContrastRatio).toBe(4.5)

    apply(pane, { ...settings, theme: 'dark' })
    expect(pane.terminal.options.minimumContrastRatio).toBe(3)
  })

  it('applies the dark-background floor in light mode when the terminal matches dark mode', () => {
    // terminalUseSeparateLightTheme=false keeps the dark terminal theme in light app mode; the gate must follow the background.
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'light', terminalUseSeparateLightTheme: false })

    expect(pane.terminal.options.minimumContrastRatio).toBe(3)
  })

  it('keeps contrast correction in dark mode when a light theme fills the dark slot', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'dark', terminalThemeDark: 'Builtin Tango Light' })

    expect(pane.terminal.options.minimumContrastRatio).toBe(4.5)
  })

  it('skips the minimumContrastRatio write on a no-op re-apply (preserves xterm contrast cache)', () => {
    const pane = makePane(1)
    let writes = 0
    let stored: number | undefined
    Object.defineProperty(pane.terminal.options, 'minimumContrastRatio', {
      configurable: true,
      enumerable: true,
      get: () => stored,
      set: (value: number) => {
        stored = value
        writes += 1
      }
    })
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, theme: 'dark' })
    const writesAfterFirst = writes

    apply(pane, { ...settings, theme: 'dark' })

    // The value-gate must not rewrite an unchanged ratio — each write clears xterm's contrast cache.
    expect(writes).toBe(writesAfterFirst)
  })
})

describe('publishTerminalViewAttributesAtAppStart', () => {
  // Hidden-at-launch PTYs query OSC 10/11 before any pane mounts; publish with no pane manager (terminal-query-authority.md).
  it('publishes composed attributes without any pane mount and dedupes repeats', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const sent: TerminalViewAttributes[] = []
    const send = (attributes: TerminalViewAttributes): boolean => {
      sent.push(attributes)
      return true
    }
    const settings = getDefaultSettings('/tmp')

    expect(publishTerminalViewAttributesAtAppStart(settings, true, send)).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.ansi).toHaveLength(256)
    expect(sent[0]!.cursorStyle).toBe(settings.terminalCursorStyle ?? 'block')

    expect(publishTerminalViewAttributesAtAppStart(settings, true, send)).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('makes the later pane-mount applyTerminalAppearance a deduped no-op re-push', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const publishMock = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { pty: { publishTerminalViewAttributes: publishMock } }
    }
    try {
      const settings = getDefaultSettings('/tmp')
      publishTerminalViewAttributesAtAppStart(settings, true)
      expect(publishMock).toHaveBeenCalledTimes(1)

      // Identical app-global snapshot, so the publisher dedupe keeps it a single push.
      const manager = {
        getPanes: () => [],
        setPaneLigaturesEnabled: vi.fn(),
        setPaneStyleOptions: vi.fn()
      } as unknown as PaneManager
      applyTerminalAppearance(
        manager,
        settings,
        true,
        new Map(),
        new Map(),
        'false',
        new Map(),
        new Map()
      )
      expect(publishMock).toHaveBeenCalledTimes(1)
    } finally {
      delete (globalThis as { window?: unknown }).window
      _resetTerminalViewAttributesPublisherForTest()
    }
  })

  it('publishes nothing before settings are loaded', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const send = vi.fn(() => true)
    expect(publishTerminalViewAttributesAtAppStart(null, true, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})
