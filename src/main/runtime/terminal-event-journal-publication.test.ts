/**
 * §5.3 publication contract: agent state was already computed headlessly, it
 * just had nowhere to go — `recordTerminalSideEffectFact` returned early with no
 * renderer consumer, so under `orca serve` no fact was published at all. These
 * pin that the journal is fed regardless of renderer presence, and that the
 * renderer's pty:sideEffect delivery is untouched by the addition.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { TerminalAwaitResult } from './terminal-multi-pane-await'

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  handleByPtyId: Map<string, string>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

/** A live runtime-owned PTY plus its control handle — enough for
 *  resolveTerminalEventPane without a renderer graph. */
function registerLivePty(runtime: OrcaRuntimeService, ptyId: string, handle: string): void {
  internals(runtime).recordPtyWorktree(ptyId, 'wt-1', { connected: true })
  internals(runtime).handleByPtyId.set(ptyId, handle)
}

function headlessRuntime(
  onTerminalSideEffects?: (batch: TerminalSideEffectBatch) => void
): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(
    undefined,
    undefined,
    onTerminalSideEffects ? { onTerminalSideEffects } : undefined
  )
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  return runtime
}

function factKinds(result: TerminalAwaitResult): string[] {
  if (result.outcome !== 'event') {
    throw new Error(`expected event, got ${result.outcome}`)
  }
  return result.events.map((event) => event.payload.kind)
}

describe('terminal event journal publication', () => {
  it('publishes agent transitions under headless serve, where no renderer sink exists', async () => {
    const batches: TerminalSideEffectBatch[] = []
    const runtime = headlessRuntime((batch) => batches.push(batch))
    registerLivePty(runtime, 'pty-1', 'h1')

    const pane = runtime.resolveTerminalEventPane('h1')
    const pending = runtime.awaitTerminalEvents([pane], { timeoutMs: 5_000 })
    await Promise.resolve()

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)

    // Both chunks land before the woken reader resumes, and it gets both in order.
    expect(factKinds(await pending)).toEqual(['agent-working', 'agent-idle'])
    // The renderer channel stayed silent, exactly as before this wiring.
    expect(batches).toEqual([])
  })

  it('batches a chunk into one journal wake so a chunk reaches a reader together', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')

    const pane = runtime.resolveTerminalEventPane('h1')
    const pending = runtime.awaitTerminalEvents([pane], { timeoutMs: 5_000 })
    await Promise.resolve()

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07out\x1b]0;Codex done\x07', 100)

    expect(factKinds(await pending)).toEqual(['agent-working', 'agent-idle'])
  })

  it('withholds spinner-rate title facts so real transitions are not evicted', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')

    const pane = runtime.resolveTerminalEventPane('h1')
    const pending = runtime.awaitTerminalEvents([pane], { timeoutMs: 5_000 })
    await Promise.resolve()

    runtime.onPtyData('pty-1', '\x1b]0;plain shell title\x07', 100)
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 101)

    expect(factKinds(await pending)).toEqual(['agent-working'])
  })

  it('leaves renderer pty:sideEffect delivery byte-identical', () => {
    const batches: TerminalSideEffectBatch[] = []
    const runtime = new OrcaRuntimeService(undefined, undefined, {
      onTerminalSideEffects: (batch) => batches.push(batch)
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const chunk = '\x1b]0;Codex working\x07response\x1b]0;Codex done\x07\x07'
    runtime.onPtyData('pty-1', chunk, 100)

    expect(batches).toHaveLength(1)
    expect(batches[0]!.seq).toBe(chunk.length)
    expect(batches[0]!.facts).toEqual([
      { kind: 'title', normalizedTitle: 'Codex working', rawTitle: 'Codex working' },
      { kind: 'agent-working' },
      { kind: 'title', normalizedTitle: 'Codex done', rawTitle: 'Codex done' },
      { kind: 'agent-idle', title: 'Codex done' },
      { kind: 'bell' }
    ])
  })

  it('feeds the journal for SSH panes, whose bytes still transit local main', async () => {
    const runtime = headlessRuntime()
    internals(runtime).recordPtyWorktree('pty-ssh', 'wt-1', { connected: true })
    internals(runtime).handleByPtyId.set('pty-ssh', 'h-ssh')

    const pane = runtime.resolveTerminalEventPane('h-ssh')
    const pending = runtime.awaitTerminalEvents([pane], { timeoutMs: 5_000 })
    await Promise.resolve()

    // Relay-delivered output reaches the same onPtyData parser as a local PTY.
    runtime.onPtyData('pty-ssh', '\x1b]0;Codex working\x07', 100)

    expect(factKinds(await pending)).toEqual(['agent-working'])
  })

  it('gaps a cursor from the previous incarnation when the PTY respawns', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')
    runtime.onPtySpawned('pty-1', 'inc-a')
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)

    const stale = runtime.resolveTerminalEventPane('h1')
    runtime.onPtySpawned('pty-1', 'inc-b')

    const result = await runtime.awaitTerminalEvents([stale], { timeoutMs: 5_000 })
    expect(result.outcome).toBe('gap')
    expect(result.outcome === 'gap' && result.reason).toBe('incarnation-changed')
  })

  it('keeps one incarnation when a real incarnationId lands on a pane that never respawned', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)

    const pane = runtime.resolveTerminalEventPane('h1')
    // A real path: the relay proves the exit generation after the fact (and SSH
    // reconnect re-registers with one) on a pane whose process never changed.
    runtime.acceptPtyIncarnationForExit('pty-1', 'inc-proven-later')
    const pending = runtime.awaitTerminalEvents([pane], { timeoutMs: 5_000 })
    await Promise.resolve()
    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)

    // A rotation here would wipe retention and tell the reader it respawned.
    expect(factKinds(await pending)).toEqual(['agent-idle'])
  })

  it('survives an SSH reattach: onPtySpawned for the same incarnation is not a respawn', async () => {
    const runtime = headlessRuntime()
    registerLivePty(runtime, 'pty-1', 'h1')
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)

    const pane = runtime.resolveTerminalEventPane('h1')
    // What ssh-relay-session does after attachForReconnect: the SAME remote process,
    // re-announced. A wifi flap must not read as a restart.
    runtime.onPtySpawned('pty-1', 'inc-1', { awaitsRegistration: false })
    const pending = runtime.awaitTerminalEvents([pane], { timeoutMs: 5_000 })
    await Promise.resolve()
    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07', 101)

    expect(factKinds(await pending)).toEqual(['agent-idle'])
  })

  it('rejects a handle this runtime does not own', () => {
    const runtime = headlessRuntime()
    expect(() => runtime.resolveTerminalEventPane('h-unknown')).toThrow('terminal_handle_stale')
  })
})
