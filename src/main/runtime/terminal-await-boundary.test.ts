/**
 * What `terminal.await` must settle in the runtime before the pure await loop
 * ever sees it: a client cursor is untrusted input, a named fact kind may have
 * no producer in this posture, and "disconnected" is not the same claim as
 * "the process died". Each of these is a place the RPC could otherwise answer
 * something it cannot back up.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { EventCursor } from './terminal-event-journal'

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  handleByPtyId: Map<string, string>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function registerLivePty(runtime: OrcaRuntimeService, ptyId: string, handle: string): void {
  internals(runtime).recordPtyWorktree(ptyId, 'wt-1', { connected: true })
  internals(runtime).handleByPtyId.set(ptyId, handle)
}

function headlessRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  return runtime
}

function windowedRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    onTerminalSideEffects: () => {}
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  return runtime
}

/** The position the runtime itself vouches for — the only cursor a caller can
 *  hold without having invented it. */
function issuedCursor(runtime: OrcaRuntimeService, handle: string): EventCursor {
  return runtime.resolveTerminalEventPane(handle).cursor
}

describe('terminal.await cursor trust boundary', () => {
  it('gaps a cursor minted by a different runtime instead of reading with it', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')

    const pane = runtime.resolveTerminalEventPane('h1', {
      ...issuedCursor(runtime, 'h1'),
      runtimeId: 'some-other-runtime'
    })
    const result = await runtime.awaitTerminalEvents([pane], { timeoutMs: 50 })

    expect(result.outcome).toBe('gap')
    expect(result.outcome === 'gap' && result.reason).toBe('incarnation-changed')
  })

  it('gaps a superseded incarnation even before the pane has published', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')

    const pane = runtime.resolveTerminalEventPane('h1', {
      ...issuedCursor(runtime, 'h1'),
      ptyIncarnationId: 'inc-from-a-dead-generation'
    })
    const result = await runtime.awaitTerminalEvents([pane], { timeoutMs: 50 })

    expect(result.outcome === 'gap' && result.reason).toBe('incarnation-changed')
  })

  it('gaps an ordinal this runtime never issued rather than parking on it', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')

    // The journal has no record for a pane that never published, so nothing
    // downstream can catch this — the boundary is the only check there is.
    const pane = runtime.resolveTerminalEventPane('h1', {
      ...issuedCursor(runtime, 'h1'),
      eventSeq: Number.MAX_SAFE_INTEGER
    })
    const result = await runtime.awaitTerminalEvents([pane], { timeoutMs: 50 })

    expect(result.outcome === 'gap' && result.reason).toBe('cursor-out-of-range')
  })

  it('resumes from the cursor it issued, and the resync cursor it returns works', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)

    const refused = runtime.resolveTerminalEventPane('h1', {
      ...issuedCursor(runtime, 'h1'),
      eventSeq: 99
    })
    const gap = await runtime.awaitTerminalEvents([refused], { timeoutMs: 50 })
    expect(gap.outcome).toBe('gap')

    // Re-arming from the returned cursor must park, not gap a second time.
    const resumed = runtime.resolveTerminalEventPane('h1', gap.cursors[0]!.cursor)
    const pending = runtime.awaitTerminalEvents([resumed], { timeoutMs: 5_000 })
    await Promise.resolve()
    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)

    const next = await pending
    expect(next.outcome === 'event' && next.events.map((e) => e.payload.kind)).toEqual([
      'agent-idle'
    ])
  })
})

describe('terminal.await fact kinds with no producer', () => {
  it('names the unproducible kinds instead of timing out on silence', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')

    const pane = runtime.resolveTerminalEventPane('h1')
    const result = await runtime.awaitTerminalEvents([pane], {
      kinds: ['bell', 'command-finished'],
      timeoutMs: 50
    })

    expect(result.outcome).toBe('unsupported')
    expect(result.outcome === 'unsupported' && result.kinds).toEqual(['bell', 'command-finished'])
    expect(result.outcome === 'unsupported' && result.reason).toBe('no-side-effect-consumer')
  })

  it('parks normally for those kinds when a renderer consumer is attached', async () => {
    const runtime = windowedRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')

    const pane = runtime.resolveTerminalEventPane('h1')
    const result = await runtime.awaitTerminalEvents([pane], { kinds: ['bell'], timeoutMs: 50 })

    expect(result.outcome).toBe('timeout')
  })

  it('reports the loss when the last window closes mid-poll', async () => {
    const runtime = windowedRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')

    const pane = runtime.resolveTerminalEventPane('h1')
    const pending = runtime.awaitTerminalEvents([pane], { kinds: ['bell'], timeoutMs: 60_000 })
    await Promise.resolve()
    runtime.markGraphUnavailable(1)
    // The park is chunked for liveness; the same pass re-asks producibility.
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)

    const result = await pending
    expect(result.outcome).toBe('unsupported')
    expect(result.outcome === 'unsupported' && result.kinds).toEqual(['bell'])
  })

  it('still parks for kinds every posture produces', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')

    const pane = runtime.resolveTerminalEventPane('h1')
    const pending = runtime.awaitTerminalEvents([pane], {
      kinds: ['agent-working'],
      timeoutMs: 5_000
    })
    await Promise.resolve()
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)

    const result = await pending
    expect(result.outcome).toBe('event')
  })
})

describe('terminal.await pane liveness', () => {
  const SSH_PTY_ID = 'ssh:host-a@@pty-1'

  it('keeps parking through a recoverable relay loss instead of declaring exit', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, SSH_PTY_ID, 'h-ssh')
    // Abnormal (negative) code on a connection-owned pane is the runtime's own
    // "transport died, the process may still be there" signal.
    runtime.onPtyExit(SSH_PTY_ID, -1)

    const pane = runtime.resolveTerminalEventPane('h-ssh')
    const result = await runtime.awaitTerminalEvents([pane], { timeoutMs: 50 })

    expect(result.outcome).toBe('timeout')
  })

  it('still reports exit for a pane whose process really ended', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')
    runtime.onPtyExit('pty-1', 0)

    const pane = runtime.resolveTerminalEventPane('h1')
    const result = await runtime.awaitTerminalEvents([pane], { timeoutMs: 5_000 })

    expect(result.outcome).toBe('exit')
  })

  it('settles a parked reader on exit with the reason, not a liveness guess', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')

    const pane = runtime.resolveTerminalEventPane('h1')
    const pending = runtime.awaitTerminalEvents([pane], { timeoutMs: 60_000 })
    await Promise.resolve()
    runtime.onPtyExit('pty-1', 0)

    const result = await pending
    expect(result.outcome).toBe('gap')
    expect(result.outcome === 'gap' && result.reason).toBe('pty-dropped')
  })
})
