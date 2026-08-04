import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AtermTerminalFacade } from '@/lib/pane-manager/aterm/aterm-terminal-facade'
import type { AtermPaneController } from '@/lib/pane-manager/aterm/aterm-pane-renderer'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { subscribeToTerminalUserInput } from '@/components/terminal-pane/terminal-user-input-signal'
import { createPreviewAtermController, createPreviewTerminalFacade } from './preview-aterm-terminal'
import { createPreviewFrameFit, sizePreviewContainerToGrid } from './preview-frame-fit'
import { createPreviewClipboardPaster } from './preview-terminal-paste'
import { installPreviewTerminalKeyHandler } from './preview-terminal-key-handler'
import { installPreviewImeBridge, type PreviewImeBridge } from './preview-terminal-ime-bridge'
import { buildPreviewAppearanceOptions } from './preview-terminal-options'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import { translate } from '@/i18n/i18n'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { createPreviewGridClaim } from './preview-grid-claim'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'

const PREVIEW_SCROLLBACK_ROWS = 24
const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24
const RESYNC_RETRY_DELAY_MS = 150

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Live interactive view of an agent's terminal, streaming from the main
 * process's per-PTY headless emulator. On open it claims the PTY grid for the
 * dialog's own box (see createPreviewGridClaim), so the terminal renders
 * properly sized rather than scaled. The terminal itself is always created at
 * the PTY's REAL cols/rows — serialized ANSI replayed into different
 * dimensions rewraps into garbage — and when someone else owns the grid (a
 * phone, a host reclaim) the oversized frame is scaled down to fit and
 * anchored so the cursor stays visible. Keystrokes pass through to the PTY.
 *
 * Rendering runs on orca's aterm engine (facade + its own pane controller),
 * not xterm: the facade is created synchronously and buffers the snapshot
 * replay until the async wasm/font build attaches, so no byte is lost.
 */
export function AgentTerminalPreview({
  ptyId,
  terminalInput = null
}: {
  ptyId: string
  /** Host-input facts relayed with the card; null routes bytes by client OS. */
  terminalInput?: DashboardCardTerminalInput | null
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const settings = useAppStore((state) => state.settings)
  const systemPrefersDark = useSystemPrefersDark()
  const macOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)
  // Why: keys must read live values without remounting the terminal (a remount
  // reconnects the pty and repaints the agent's screen from a new snapshot).
  const settingsRef = useRef(settings)
  const macOptionAsAltRef = useRef(macOptionAsAlt)
  const terminalInputRef = useRef(terminalInput)
  // The live facade/controller, mirrored out of the connection effect so the
  // appearance sync can reach them without re-running (and remounting) it.
  const terminalRef = useRef<AtermTerminalFacade | null>(null)
  const controllerRef = useRef<AtermPaneController | null>(null)
  const { terminalTheme, terminalMode } = useMemo(() => {
    if (!settings) {
      return { terminalTheme: null, terminalMode: 'dark' as const }
    }
    const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    const theme = composeActiveTerminalTheme(
      appearance.theme ?? getBuiltinTheme(appearance.themeName),
      settings
    )
    return { terminalTheme: theme, terminalMode: appearance.mode }
  }, [settings, systemPrefersDark])
  // A null snapshot means no serializer knows this pty (it died or was never
  // spawned this session) — say so instead of painting a silent blank terminal.
  const [ptyGone, setPtyGone] = useState(false)

  // Why: refs are seeded at first render and refreshed on commit — assigning
  // during render trips react-compiler. Layout, not passive: the key handler is
  // a native listener, so React would not flush a passive effect before the
  // next keystroke and a just-relayed profile could miss it.
  useLayoutEffect(() => {
    settingsRef.current = settings
    macOptionAsAltRef.current = macOptionAsAlt
    terminalInputRef.current = terminalInput
  }, [settings, macOptionAsAlt, terminalInput])

  useEffect(() => {
    setPtyGone(false)
    const container = containerRef.current
    if (!container) {
      return
    }
    let disposed = false
    let terminal: AtermTerminalFacade | null = null
    let controller: AtermPaneController | null = null
    let offData: (() => void) | null = null
    let userInputDisposable: { dispose: () => void } | null = null
    let imeBridge: PreviewImeBridge | null = null
    let disposeKeyHandler: (() => void) | null = null
    // Why: mirrors the pane's tracker — the shortcut policy needs the flags the
    // TUI negotiated, and this preview parses the same output stream.
    const kittyKeyboardModes = new TerminalKittyKeyboardModeTracker()
    let refreshInFlight = false
    let refreshAgain = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let pendingUserInputSignals = 0
    const pendingLivePayloads: Extract<TerminalPreviewDataPayload, { type: 'data' }>[] = []

    const frameFit = createPreviewFrameFit(container, () => terminal)
    const scheduleFit = (): void => frameFit.schedule()
    const syncContainerToGrid = (): void =>
      sizePreviewContainerToGrid(container, terminal, controller)

    const gridClaim = createPreviewGridClaim({
      ptyId,
      container,
      getTerminal: () => terminal
    })
    // Box growth/shrink (window resize) changes the reachable grid.
    const boxResizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            scheduleFit()
            gridClaim.schedule()
          })
    if (container.parentElement) {
      boxResizeObserver?.observe(container.parentElement)
    }
    boxResizeObserver?.observe(container)

    let replayDepth = 0
    const writeReplayed = (chunk: string, onDone?: () => void, live = false): void => {
      // Why: a redelivered snapshot repeats the TUI's one-time kitty push, so
      // replayed bytes must apply as idempotent sets (see the tracker's docs).
      if (live) {
        kittyKeyboardModes.scan(chunk)
      } else {
        kittyKeyboardModes.scanReplay(chunk)
      }
      replayDepth++
      terminal?.write(chunk, () => {
        replayDepth--
        scheduleFit()
        onDone?.()
      })
    }

    const writeLive = (payload: Extract<TerminalPreviewDataPayload, { type: 'data' }>): void => {
      if (!terminal) {
        pendingLivePayloads.push(payload)
        return
      }
      writeReplayed(
        payload.data,
        () => {
          if (!disposed) {
            void window.api.terminalPreview.ack(ptyId, payload.bytes)
          }
        },
        true
      )
    }

    const sendPtyInput = (data: string): void => {
      if (!disposed) {
        void window.api.terminalPreview.input(ptyId, data)
      }
    }

    const pasteClipboardText = createPreviewClipboardPaster({
      ptyId,
      container,
      getTerminal: () => terminal,
      isDisposed: () => disposed
    })

    const disposeImeNativeTextBridge = (): void => {
      imeBridge?.dispose()
      imeBridge = null
    }

    const installKeyHandler = (facade: AtermTerminalFacade): void => {
      disposeKeyHandler = installPreviewTerminalKeyHandler({
        terminal: facade,
        claimImeKeyEvent: (event) => imeBridge?.claimKeyEvent(event) ?? false,
        pasteClipboardText: (activeElement, source) =>
          void pasteClipboardText(activeElement, source),
        // Why: route through facade.input so the chord's bytes carry the host-synthesized-input signal, like typed keys.
        sendInput: (data) => terminal?.input(data),
        getShortcutContext: () => ({
          clientPlatform: getShortcutPlatform(),
          macOptionAsAlt: macOptionAsAltRef.current,
          keybindings: useAppStore.getState().keybindings,
          terminalInput: terminalInputRef.current,
          kittyKeyboardActive: () => kittyKeyboardModes.flags > 0,
          terminalShortcutPolicy: settingsRef.current?.terminalShortcutPolicy
        })
      })
    }

    // Host-synthesized input only (the IME forwarder's facade.input, the paste
    // coordinator and the engine's paste sink via facade.paste) — all of it is
    // real user input, so it bypasses the gesture gate the engine sink needs.
    const installInputRouting = (facade: AtermTerminalFacade): void => {
      facade.onData(sendPtyInput)
    }

    // Why: the engine's input sink mixes real gestures with its own auto-replies
    // (focus reports, drained DA/DSR/CPR), so the DOM user-input signal — orca's
    // classifier for exactly this seam — decides what reaches the PTY; typing
    // survives live replay without forwarding synthetic bytes.
    const routeEngineInput = (data: string): void => {
      const signaledUserInput = pendingUserInputSignals > 0
      if (signaledUserInput) {
        pendingUserInputSignals--
      }
      if (userInputDisposable ? !signaledUserInput : replayDepth > 0) {
        return
      }
      sendPtyInput(data)
    }

    // Build the engine behind the already-live facade. A preview torn down (or
    // reconnected onto a fresh facade) mid-build drops the controller instead of
    // attaching a leaked canvas.
    const attachRenderer = async (facade: AtermTerminalFacade): Promise<void> => {
      let created: AtermPaneController
      try {
        created = await createPreviewAtermController({
          container,
          facade,
          theme: terminalTheme,
          onEngineInput: routeEngineInput
        })
      } catch (error) {
        console.error('[dashboard-popout] aterm preview renderer failed to load', error)
        return
      }
      if (disposed || terminal !== facade) {
        created.dispose()
        return
      }
      controller = created
      controllerRef.current = created
      facade.__attachController(created, {
        element: created.element,
        textarea: created.textarea
      })
      syncContainerToGrid()
      userInputDisposable = subscribeToTerminalUserInput(facade, created.element, () => {
        pendingUserInputSignals = Math.min(32, pendingUserInputSignals + 1)
      })
      imeBridge = installPreviewImeBridge(facade)
      installKeyHandler(facade)
      created.scheduleDraw()
      scheduleFit()
      gridClaim.schedule()
      facade.focus()
    }

    const createPreviewTerminal = (cols: number, rows: number): AtermTerminalFacade => {
      const facade = createPreviewTerminalFacade({
        settings: settingsRef.current,
        terminalInput: terminalInputRef.current,
        macOptionIsMeta: macOptionAsAltRef.current === 'true',
        theme: terminalTheme,
        appSurface: terminalMode,
        cols,
        rows
      })
      terminal = facade
      terminalRef.current = facade
      installInputRouting(facade)
      void attachRenderer(facade)
      return facade
    }

    const replayConnection = (
      connection: Awaited<ReturnType<typeof window.api.terminalPreview.connect>>,
      replaceExisting: boolean,
      requestRefresh: () => void
    ): void => {
      const snap = connection.snapshot!
      const cols = clamp(snap.cols ?? FALLBACK_COLS, 2, 500)
      const rows = clamp(snap.rows ?? FALLBACK_ROWS, 2, 200)
      let facade = terminal
      if (!facade) {
        facade = createPreviewTerminal(cols, rows)
      } else if (replaceExisting) {
        // Why: keep the old frame visible during capture, then atomically replace it once the authoritative snapshot arrives.
        facade.resize(cols, rows)
        // aterm's facade has no reset() (the engine owns rendering); clear() is
        // its screen + scrollback wipe, which is what the replacement needs.
        facade.clear()
        // Why: the mirror must restart from the incoming snapshot instead of the
        // dead session's negotiated flags.
        kittyKeyboardModes.reset()
        syncContainerToGrid()
      }
      if (snap.scrollbackAnsi) {
        writeReplayed(snap.scrollbackAnsi)
      }
      if (snap.data) {
        writeReplayed(snap.data)
      }
      if (snap.pendingEscapeTailAnsi) {
        writeReplayed(snap.pendingEscapeTailAnsi)
      }
      for (const data of connection.replay) {
        writeReplayed(data)
      }
      for (const payload of pendingLivePayloads.splice(0)) {
        writeLive(payload)
      }
      if (connection.resyncRequired) {
        refreshAgain = false
        // Why: sustained output can overflow every capture; delay retries so recovery cannot spin two serializations per event-loop turn.
        writeReplayed('', () => {
          if (disposed || retryTimer) {
            return
          }
          retryTimer = setTimeout(() => {
            retryTimer = null
            requestRefresh()
          }, RESYNC_RETRY_DELAY_MS)
        })
      } else if (refreshAgain) {
        refreshAgain = false
        // Queue behind every replay write so replacement never clears a half-parsed frame.
        writeReplayed('', requestRefresh)
      }
      scheduleFit()
      gridClaim.schedule()
      facade.focus()
    }

    const setup = async (replaceExisting = false): Promise<void> => {
      if (refreshInFlight) {
        refreshAgain = true
        return
      }
      refreshInFlight = true
      const connection = await window.api.terminalPreview.connect(ptyId, {
        scrollbackRows: PREVIEW_SCROLLBACK_ROWS
      })
      if (disposed) {
        return
      }
      const snap = connection.snapshot
      if (!snap) {
        refreshInFlight = false
        setPtyGone(true)
        offData?.()
        offData = null
        userInputDisposable?.dispose()
        userInputDisposable = null
        pendingUserInputSignals = 0
        disposeImeNativeTextBridge()
        disposeKeyHandler?.()
        disposeKeyHandler = null
        // Disposing the facade disposes its controller, which removes the aterm
        // DOM — drop the grid-sized box with it so a reconnect measures fresh.
        terminal?.dispose()
        terminal = null
        controller = null
        terminalRef.current = null
        controllerRef.current = null
        container.style.width = ''
        container.style.height = ''
        void window.api.terminalPreview.unsubscribe(ptyId)
        return
      }
      refreshInFlight = false
      if (!connection.resyncRequired && retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      replayConnection(connection, replaceExisting, () => void setup(true))
    }

    // Why: the popout has no TerminalPane/useAppMenuPaste, so the Edit menu's
    // Cmd/Ctrl+V (routed to the focused window as ui:appMenuPaste) would
    // otherwise be dropped and paste would silently do nothing here.
    const offAppMenuPaste = window.api.ui.onAppMenuPaste(() => {
      const active = document.activeElement
      if (active && container.contains(active)) {
        void pasteClipboardText(active, 'app-menu')
      }
    })

    offData = window.api.terminalPreview.onData((payload) => {
      if (payload.ptyId !== ptyId) {
        return
      }
      if (payload.type === 'resync') {
        void setup(true)
        return
      }
      writeLive(payload)
    })

    void setup()

    return () => {
      disposed = true
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      gridClaim.dispose()
      boxResizeObserver?.disconnect()
      offAppMenuPaste()
      offData?.()
      userInputDisposable?.dispose()
      disposeImeNativeTextBridge()
      disposeKeyHandler?.()
      void window.api.terminalPreview.unsubscribe(ptyId)
      terminal?.dispose()
      controller = null
      terminalRef.current = null
      controllerRef.current = null
    }
  }, [ptyId, terminalTheme, terminalMode])

  // Why: the OS layout probe can flip macOptionAsAlt with no settings change (so
  // no remount) — refresh the bag the engine reads live, in place.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    Object.assign(
      terminal.options,
      buildPreviewAppearanceOptions(settings, macOptionAsAlt === 'true')
    )
    // Engine-side settings that aren't read per frame (ligatures, scrollback depth,
    // default cursor shape, word separators, opacity) need an explicit re-apply.
    controllerRef.current?.reapplyEngineSettings()
    controllerRef.current?.scheduleDraw()
  }, [settings, macOptionAsAlt])

  return (
    // Why: a size FIXED by the viewport (not shrink-to-fit) + overflow-hidden
    // keeps the dialog stable no matter how wide/tall the pane's serialized
    // buffer is. The terminal keeps the pane's true dimensions and is scaled/
    // clipped to fit; fitToBox anchors whichever end keeps the cursor in view.
    <div
      className="relative h-[calc(100vh-140px)] w-full overflow-hidden bg-background p-1.5"
      style={terminalTheme?.background ? { backgroundColor: terminalTheme.background } : undefined}
    >
      {ptyGone ? (
        <div className="absolute inset-0 flex items-center justify-center px-2.5 py-8 text-center text-[11px] text-muted-foreground">
          {translate(
            'dashboardPopout.terminal.closed',
            "No live terminal — this agent's pane has closed."
          )}
        </div>
      ) : null}
      <div
        aria-hidden={ptyGone || undefined}
        className={cn('flex h-full w-full items-end overflow-hidden', ptyGone && 'invisible')}
      >
        <div ref={containerRef} className="origin-bottom-left" />
      </div>
    </div>
  )
}
