import { randomUUID } from 'node:crypto'
import { test, expect } from './helpers/orca-app'
import { focusActiveTerminalInput, waitForActivePanePtyId } from './helpers/terminal'
import { waitForAtermControllerByPtyId } from './helpers/aterm-controller'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

// TYPING GATE for the SHIPPED default render path — the hole that let a keystroke
// regression reach main (b65161554d). A worker-backed `term` has no
// `term.encode_key`, so selectAtermEngineKeyEncoder routes EVERY keystroke through
// the MAIN-THREAD CPU glue, which throws until `loadAterm()` registers it; when the
// worker path lost its only loadAterm() call, typing threw on every pane.
//
// Nothing caught it: the unit suites mock the engine registry, and the one spec that
// types (aterm-click-focus-type) runs under the fixture's suite-wide
// `__atermWorkerRender = false` opt-out — the IN-PROCESS path, whose `term` HAS
// encode_key and whose drawer awaits loadAterm() anyway. So this spec opts back in to
// the shipped default (worker) + the macOS 'auto' resolution (GPU) BEFORE the pane is
// built, and types for real.
//
// Three assertions, because the round-trip ALONE does not detect this regression:
// printable keydowns return null before reaching the encoder (they flow through the
// textarea 'input' event), and a throwing Enter keydown never reaches its
// `preventDefault()` — so the browser's own newline default lands in the textarea and
// the input path submits the line BY ACCIDENT. The round-trip therefore proves the
// pane works end to end; what pins the encoder itself is (a) Enter being CONSUMED
// (`defaultPrevented`) by the engine encoder, and (b) zero glue/encoder errors.

const GLUE_ERROR_RE = /wasm glue|glue not loaded|encode_key|atermCpuGlue|key encoder/i

type TypingGateProbe = { enterDefaultPrevented: boolean | null }
type TypingGateWindow = Window & { __orcaTypingGateProbe?: TypingGateProbe }
type PaneManagersWindow = Window & {
  __paneManagers?: Map<
    string,
    {
      getPanes?: () => {
        container?: { dataset?: { ptyId?: string }; querySelector: (s: string) => Element | null }
      }[]
    }
  >
}

// Scope every DOM read to the pane under test: the seeded baseline tab leaves a
// hidden background aterm canvas that a DOM-first/last match would find instead.
function paneElementByPtyId(ptyId: string, selector: string): Element | null {
  const managers = (window as PaneManagersWindow).__paneManagers
  for (const manager of managers?.values() ?? []) {
    for (const pane of manager.getPanes?.() ?? []) {
      if (pane?.container?.dataset?.ptyId === ptyId) {
        return pane.container.querySelector(selector)
      }
    }
  }
  return null
}

test.describe('aterm worker-path typing', () => {
  test('a typed command round-trips on the default worker engine path', async ({ orcaPage }) => {
    const errors: string[] = []
    orcaPage.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
    orcaPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(`console.error: ${msg.text()}`)
      }
    })
    const glueErrors = (): string[] => errors.filter((entry) => GLUE_ERROR_RE.test(entry))

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    // Restore the SHIPPED defaults for the pane this spec builds: the render worker
    // (the fixture opts the whole suite out so in-process canvas assertions hold) and
    // the GPU engine (macOS 'auto' resolves to GPU; forcing it skips the auto policy's
    // software-renderer rejection that headless WebGL would otherwise trip). The worker
    // still falls back to its own CPU engine if it cannot acquire GL — both are the
    // worker path, which is what this gate is about.
    await orcaPage.evaluate(() => {
      ;(window as unknown as { __atermWorkerRender?: boolean }).__atermWorkerRender = true
      ;(window as unknown as { __atermGpuEnabled?: boolean }).__atermGpuEnabled = true
    })

    await orcaPage.getByRole('button', { name: 'New tab' }).click()
    await orcaPage
      .getByRole('menuitem', { name: /New Terminal/i })
      .first()
      .click()

    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForAtermControllerByPtyId(orcaPage, ptyId)

    // GUARD against a vacuous pass: if worker init failed, loadAtermStrategy silently
    // falls back in-process, where the drawer loads the glue and the term HAS
    // encode_key — the regression cannot reproduce there. The worker owns the canvas
    // via transferControlToOffscreen, so getContext THROWS on the main side; an
    // in-process CPU pane returns a live 2d context and a GPU pane returns null, both
    // WITHOUT throwing.
    const ownership = await orcaPage.evaluate(
      ({ id, findSrc }) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const find = new Function(`return (${findSrc})`)() as (
          ptyId: string,
          selector: string
        ) => Element | null
        const canvas = find(id, '[data-testid="aterm-canvas"]') as HTMLCanvasElement | null
        if (!canvas) {
          return { transferred: false, detail: 'no canvas' }
        }
        try {
          const ctx = canvas.getContext('2d')
          return {
            transferred: false,
            detail: ctx ? 'has 2d (in-process CPU)' : 'null 2d (in-process GPU)'
          }
        } catch (error) {
          return { transferred: true, detail: String(error) }
        }
      },
      { id: ptyId, findSrc: paneElementByPtyId.toString() }
    )
    expect(
      ownership.transferred,
      `the pane must be worker-backed (the path with no term.encode_key); got: ${ownership.detail}`
    ).toBe(true)

    // The shell must be at its read loop before typing, or its line editor eats the
    // keystrokes and the round-trip assertion fails for an unrelated reason.
    await waitForPtyShellEcho(orcaPage, ptyId, 45_000)

    await focusActiveTerminalInput(orcaPage)
    const focused = await orcaPage.evaluate(
      () => document.activeElement?.className ?? document.activeElement?.tagName ?? 'null'
    )
    expect(focused, 'keystrokes must land on the aterm helper textarea').toContain(
      'xterm-helper-textarea'
    )

    // Probe the SAME textarea aterm wires, in the bubble phase and registered after
    // it: an exception in aterm's listener does not stop ours, so a keydown that
    // throws in the engine encoder is observable here as defaultPrevented === false.
    const probeInstalled = await orcaPage.evaluate(
      ({ id, findSrc }) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const find = new Function(`return (${findSrc})`)() as (
          ptyId: string,
          selector: string
        ) => Element | null
        const textarea = find(id, '.xterm-helper-textarea')
        if (!textarea) {
          return false
        }
        const probe: TypingGateProbe = { enterDefaultPrevented: null }
        ;(window as TypingGateWindow).__orcaTypingGateProbe = probe
        textarea.addEventListener('keydown', (event) => {
          if ((event as KeyboardEvent).key === 'Enter') {
            probe.enterDefaultPrevented = event.defaultPrevented
          }
        })
        return true
      },
      { id: ptyId, findSrc: paneElementByPtyId.toString() }
    )
    expect(probeInstalled, "the pane under test should expose aterm's helper textarea").toBe(true)

    // Unique per run so a stale a11y-mirror line can never satisfy the count.
    const marker = `ORCA_TYPE_GATE_${randomUUID().slice(0, 8).toUpperCase()}`
    await orcaPage.keyboard.type(`echo ${marker}`)
    await orcaPage.keyboard.press('Enter')

    // The grid's a11y mirror carries rendered text into document.body.innerText, so a
    // completed round-trip leaves the marker twice: the echoed command line and the
    // shell's output line. Stop early on a glue/encoder error so a regression reports
    // its real cause instead of a 20s timeout.
    let markerCount = 0
    await expect
      .poll(
        async () => {
          markerCount = await orcaPage.evaluate(
            (m) => document.body.innerText.split(m).length - 1,
            marker
          )
          return markerCount >= 2 || glueErrors().length > 0
        },
        {
          timeout: 20_000,
          message:
            'the typed command never round-tripped (expected the echoed command AND the shell output)'
        }
      )
      .toBe(true)

    expect(glueErrors(), 'typing must not raise a wasm-glue/key-encoder error').toEqual([])
    expect(
      markerCount,
      'the marker must appear twice — the echoed command AND the shell output'
    ).toBeGreaterThanOrEqual(2)
    const enterDefaultPrevented = await orcaPage.evaluate(
      () => (window as TypingGateWindow).__orcaTypingGateProbe?.enterDefaultPrevented ?? null
    )
    expect(
      enterDefaultPrevented,
      'Enter must be engine-encoded and consumed — false means the encoder threw before preventDefault'
    ).toBe(true)

    const engine = await orcaPage.evaluate(
      () =>
        (window as unknown as { __atermWorkerRenderState?: { engine?: string } })
          .__atermWorkerRenderState?.engine ?? 'unknown'
    )
    // eslint-disable-next-line no-console
    console.log(
      `[aterm-worker-typing] PASS — worker engine: ${engine}, marker hits: ${markerCount}`
    )
  })
})
