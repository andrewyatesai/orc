import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-identity'
import { AgentHookServer, PANE_KEY_ALIASES_MAX } from './server'

const SOURCE = makePaneKey('tab-source', '11111111-1111-4111-8111-111111111111')
const TARGET = makePaneKey('tab-target', '22222222-2222-4222-8222-222222222222')
const FINAL = makePaneKey('tab-final', '33333333-3333-4333-8333-333333333333')
const SIBLING = makePaneKey('tab-target', '44444444-4444-4444-8444-444444444444')

describe('AgentHookServer pane authority', () => {
  it('keeps physical hooks routed after the source tab closes and suppresses them after owner retire', () => {
    const server = new AgentHookServer()
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'source' }
    })

    server.transferPaneAuthority(SOURCE, TARGET, 'pty-1')
    server.dropStatusEntriesByTabPrefix('tab-source')
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'after source close' }
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: TARGET,
        tabId: 'tab-target',
        prompt: 'after source close'
      })
    ])

    server.ingestTerminalStatus({
      paneKey: SIBLING,
      tabId: 'tab-target',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'sibling' }
    })
    server.retirePaneAuthority(TARGET)
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'done', prompt: 'too late' }
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: SIBLING, prompt: 'sibling' })
    ])
  })

  it('persists one physical alias while chained transfers advance its owner', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setPaneKeyAliasPersistenceListener(listener)

    server.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10)
    server.transferPaneAuthority(TARGET, FINAL, 'pty-1', 20)

    expect(listener).toHaveBeenLastCalledWith([
      {
        legacyPaneKey: SOURCE,
        stablePaneKey: FINAL,
        ptyId: 'pty-1',
        updatedAt: 20
      }
    ])
  })

  it('requires live PTY ownership for a first transfer and trusts the chained alias afterward', () => {
    const server = new AgentHookServer()

    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'unverified source' }
    })

    expect(server.canTransferPaneAuthority(SOURCE, undefined, () => false)).toBe(false)
    expect(server.canTransferPaneAuthority(SOURCE, 'pty-1', () => false)).toBe(false)
    expect(
      server.canTransferPaneAuthority(SOURCE, 'pty-1', (paneKey, ptyId) => {
        return paneKey === SOURCE && ptyId === 'pty-1'
      })
    ).toBe(true)

    server.transferPaneAuthority(SOURCE, TARGET, 'pty-1')
    expect(server.canTransferPaneAuthority(TARGET, undefined, () => false)).toBe(true)
    expect(server.canTransferPaneAuthority(TARGET, 'pty-1', () => false)).toBe(true)
    expect(server.canTransferPaneAuthority(TARGET, 'other-pty', () => false)).toBe(false)
  })

  it('does not treat registered or restored aliases as verified authority', () => {
    const registered = new AgentHookServer()
    registered.registerPaneKeyAlias('tab-source:0', SOURCE, 'pty-1')

    expect(registered.canTransferPaneAuthority(SOURCE, undefined, () => false)).toBe(false)
    expect(registered.canTransferPaneAuthority(SOURCE, 'pty-1', () => false)).toBe(false)
    expect(
      registered.canTransferPaneAuthority(SOURCE, 'pty-1', (paneKey, ptyId) => {
        return paneKey === 'tab-source:0' && ptyId === 'pty-1'
      })
    ).toBe(true)

    const restored = new AgentHookServer()
    restored.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10, { authorityVerified: false })
    expect(restored.canTransferPaneAuthority(TARGET, undefined, () => false)).toBe(false)
    expect(restored.canTransferPaneAuthority(TARGET, 'pty-1', () => false)).toBe(false)
    expect(
      restored.canTransferPaneAuthority(TARGET, 'pty-1', (paneKey, ptyId) => {
        return paneKey === TARGET && ptyId === 'pty-1'
      })
    ).toBe(true)
    restored.transferPaneAuthority(TARGET, FINAL, 'pty-1', 20)
    expect(restored.canTransferPaneAuthority(FINAL, undefined, () => false)).toBe(true)
  })

  it('prefers a spawn-verified legacy alias over an earlier migration fallback', () => {
    const server = new AgentHookServer()
    server.registerPaneKeyAlias('tab-source:0', SOURCE, 'pty-1')
    server.registerPaneKeyAlias('tab-source:1', SOURCE, 'pty-1', 20, {
      authorityVerified: true
    })

    expect(server.canTransferPaneAuthority(SOURCE, undefined, () => false)).toBe(true)
    expect(server.canTransferPaneAuthority(SOURCE, 'pty-1', () => false)).toBe(true)
  })

  it('bounds persisted aliases by evicting the oldest authority', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setPaneKeyAliasPersistenceListener(listener)

    for (let index = 0; index <= PANE_KEY_ALIASES_MAX; index += 1) {
      const suffix = index.toString(16).padStart(12, '0')
      server.transferPaneAuthority(
        makePaneKey(`source-${index}`, `00000000-0000-4000-8000-${suffix}`),
        makePaneKey(`target-${index}`, `10000000-0000-4000-8000-${suffix}`),
        `pty-${index}`,
        index + 1
      )
    }

    const persisted = listener.mock.calls.at(-1)?.[0]
    expect(persisted).toHaveLength(PANE_KEY_ALIASES_MAX)
    expect(persisted).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ legacyPaneKey: expect.stringContaining('source-0:') })
      ])
    )
  })

  // STA-4114: a detach/reattach cycle retires the pane and nothing ever lifted the
  // fence, so a still-running agent stayed suppressed for the rest of its life. Binding
  // a live PTY to the exact pane disproves the retirement claim and must lift it —
  // without waiting for a new turn, which a pane re-attached mid-turn or idle never emits.
  it('re-attaching a retired pane lifts the fence without waiting for a new turn', () => {
    const server = new AgentHookServer()
    server.ingestTerminalStatus({
      paneKey: TARGET,
      tabId: 'tab-target',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'turn in flight' }
    })
    server.retirePaneAuthority(TARGET)

    // The turn was already running, so only its completion is left to report — and
    // while retired it is suppressed. This is the reported permanent failure.
    server.ingestTerminalStatus({
      paneKey: TARGET,
      tabId: 'tab-target',
      worktreeId: 'wt-1',
      payload: { state: 'done', prompt: 'turn in flight' }
    })
    expect(server.getStatusSnapshot()).toEqual([])

    expect(server.restorePaneAuthority(TARGET)).toBe(true)

    server.ingestTerminalStatus({
      paneKey: TARGET,
      tabId: 'tab-target',
      worktreeId: 'wt-1',
      payload: { state: 'done', prompt: 'turn in flight' }
    })
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: TARGET, state: 'done' })
    ])
  })

  // The canonical case: a detached pane's process keeps posting the key it launched
  // under, so restoring only the owner key leaves that alias stranded and the row comes
  // back under the stale launch pane. The fence must be replayed as a unit, rebuilding
  // the aliases retirement deleted, so the live process routes back to its real owner.
  it('rebuilds a deleted launch alias on re-attach so a detached pane routes to its owner', () => {
    const server = new AgentHookServer()
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'launch' }
    })
    server.transferPaneAuthority(SOURCE, TARGET, 'pty-1')
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'still running' }
    })
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: TARGET, prompt: 'still running' })
    ])

    // Retirement fences {SOURCE, TARGET} and deletes the SOURCE alias.
    server.retirePaneAuthority(TARGET)
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'done', prompt: 'suppressed' }
    })
    expect(server.getStatusSnapshot()).toEqual([])

    expect(server.restorePaneAuthority(TARGET)).toBe(true)
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'done', prompt: 'back under owner' }
    })
    // Routed to TARGET, not the stale launch pane SOURCE — the alias was replayed.
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: TARGET, prompt: 'back under owner' })
    ])
  })

  // A closed *tab* is a stronger, separate claim: a live process must never be routed
  // back into a tab the user closed, so re-attach leaves that tombstone standing.
  it('does not lift a closed-tab tombstone on re-attach', () => {
    const server = new AgentHookServer()
    server.ingestTerminalStatus({
      paneKey: TARGET,
      tabId: 'tab-target',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'before close' }
    })
    server.retirePaneAuthority(TARGET)
    server.dropStatusEntriesByTabPrefix('tab-target')

    expect(server.restorePaneAuthority(TARGET)).toBe(false)

    server.ingestTerminalStatus({
      paneKey: TARGET,
      tabId: 'tab-target',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'after close' }
    })
    expect(server.getStatusSnapshot()).toEqual([])
  })
})
