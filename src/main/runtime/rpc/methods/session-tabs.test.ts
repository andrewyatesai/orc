import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { SESSION_TAB_METHODS } from './session-tabs'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('session tab RPC methods', () => {
  it('routes mobile-only activation without notifying desktop clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      activateMobileSessionTab: vi.fn().mockResolvedValue({
        worktree: 'wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: 'tab-1',
        activeTabType: 'terminal',
        tabs: []
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.activate', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        notifyClients: false
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.activateMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', 'leaf-1', {
      notifyClients: false,
      clientNavigationId: undefined,
      navigation: 'caller'
    })
  })

  it('defaults legacy paired activation to the authenticated caller identity', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      activateMobileSessionTab: vi.fn().mockResolvedValue({ tabs: [] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.activate', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        notifyClients: true
      }),
      (response) => replies.push(response),
      { clientKind: 'runtime', pairedDeviceId: 'device-a' }
    )

    expect(replies).toHaveLength(1)
    expect(runtime.activateMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', undefined, {
      notifyClients: true,
      clientNavigationId: 'device-a',
      navigation: 'caller'
    })
  })

  it('refuses a reasonless close without invoking destructive runtime logic', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      refuseUnattributedMobileSessionTabClose: vi.fn().mockResolvedValue({
        closed: true,
        refused: true,
        snapshotRepublished: true
      }),
      closeMobileSessionTab: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { closed: true, refused: true, snapshotRepublished: true }
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).toHaveBeenCalledWith('id:wt-1', 'tab-1')
    expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
  })

  it('passes explicit user intent to host adjudication', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      refuseUnattributedMobileSessionTabClose: vi.fn(),
      closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.close', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        reason: 'user'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', {
      reason: 'user'
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).not.toHaveBeenCalled()
  })

  it('preserves explicit user closes from current runtime clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      refuseUnattributedMobileSessionTabClose: vi.fn(),
      closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        reason: 'user'
      }),
      (response) => replies.push(response),
      { clientKind: 'runtime', pairedDeviceId: 'current-runtime' }
    )

    expect(replies).toHaveLength(1)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', {
      reason: 'user',
      clientNavigationId: 'current-runtime'
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).not.toHaveBeenCalled()
  })

  it('preserves reasonless explicit closes from authenticated legacy mobile clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      refuseUnattributedMobileSessionTabClose: vi.fn(),
      closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' }),
      (response) => replies.push(response),
      { clientKind: 'mobile' }
    )

    expect(replies).toHaveLength(1)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', {
      reason: 'user'
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).not.toHaveBeenCalled()
  })

  it('preserves reasonless closes from authenticated legacy runtime clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      refuseUnattributedMobileSessionTabClose: vi.fn(),
      closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' }),
      (response) => replies.push(response),
      { clientKind: 'runtime', pairedDeviceId: 'legacy-runtime' }
    )

    expect(replies).toHaveLength(1)
    expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', {
      reason: 'user',
      clientNavigationId: 'legacy-runtime'
    })
    expect(runtime.refuseUnattributedMobileSessionTabClose).not.toHaveBeenCalled()
  })

  it('refuses reasonless closes from runtime clients that negotiated explicit intent', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      refuseUnattributedMobileSessionTabClose: vi.fn().mockResolvedValue({
        closed: true,
        refused: true,
        refusalReason: 'missing-intent',
        snapshotRepublished: true
      }),
      closeMobileSessionTab: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.close', { worktree: 'id:wt-1', tabId: 'tab-1' }),
      (response) => replies.push(response),
      {
        clientKind: 'runtime',
        pairedDeviceId: 'current-runtime',
        clientCapabilities: [SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY]
      }
    )

    expect(replies).toHaveLength(1)
    expect(runtime.refuseUnattributedMobileSessionTabClose).toHaveBeenCalledWith('id:wt-1', 'tab-1')
    expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
  })

  it.each(['pty-exit', 'cleanup'] as const)(
    'rejects %s on the legacy close endpoint before host adjudication',
    async (reason) => {
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        closeMobileSessionTab: vi.fn()
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest('session.tabs.close', {
          worktree: 'id:wt-1',
          tabId: 'tab-1',
          reason
        })
      )

      expect(response.ok).toBe(false)
      expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
    }
  )

  it.each(['pty-exit', 'cleanup'] as const)(
    'binds a %s lifecycle close to the observed publication and terminal',
    async (reason) => {
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        closeMobileSessionTab: vi.fn().mockResolvedValue({ closed: true })
      } as unknown as OrcaRuntimeService
      const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

      const response = await dispatcher.dispatch(
        makeRequest('session.tabs.closeLifecycle', {
          worktree: 'id:wt-1',
          tabId: 'tab-1',
          reason,
          publicationEpoch: 'epoch-1',
          terminal: 'term-1'
        })
      )

      expect(response.ok).toBe(true)
      expect(runtime.closeMobileSessionTab).toHaveBeenCalledWith('id:wt-1', 'tab-1', {
        reason,
        expectedPublicationEpoch: 'epoch-1',
        expectedTerminalHandle: 'term-1'
      })
    }
  )

  it('dispatches tab moves through the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      moveMobileSessionTab: vi.fn().mockResolvedValue({
        moved: true
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.move', {
        worktree: 'id:wt-1',
        tabId: 'tab-1::leaf-1',
        targetGroupId: 'group-left',
        kind: 'reorder',
        tabOrder: ['tab-2::leaf-1', 'tab-1::leaf-1']
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.moveMobileSessionTab).toHaveBeenCalledWith('id:wt-1', {
      tabId: 'tab-1::leaf-1',
      targetGroupId: 'group-left',
      kind: 'reorder',
      tabOrder: ['tab-2::leaf-1', 'tab-1::leaf-1']
    })
  })

  it('rejects ambiguous tab move payloads', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      moveMobileSessionTab: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.move', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        targetGroupId: 'group-1',
        kind: 'reorder',
        splitDirection: 'right',
        tabOrder: ['tab-1']
      })
    )

    expect(response.ok).toBe(false)
    expect(runtime.moveMobileSessionTab).not.toHaveBeenCalled()
  })

  it('dispatches split tab moves without reorder-only fields', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      moveMobileSessionTab: vi.fn().mockResolvedValue({ moved: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.move', {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        targetGroupId: 'group-2',
        kind: 'split',
        splitDirection: 'right'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.moveMobileSessionTab).toHaveBeenCalledWith('id:wt-1', {
      tabId: 'tab-1',
      targetGroupId: 'group-2',
      kind: 'split',
      splitDirection: 'right'
    })
  })

  it('dispatches ordinary terminal creation with the requested tab group', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Terminal',
          status: 'ready',
          terminal: 'pty-1',
          isActive: true
        },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        targetGroupId: 'group-left',
        command: 'zsh',
        cwd: '/repo/packages/app',
        env: { CODEX_PROFILE: 'captured' },
        envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
        launchToken: 'launch-token-123',
        launchConfig: {
          agentArgs: '--model gpt-5',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        launchAgent: 'codex',
        viewMode: 'chat',
        activate: true
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledWith('id:wt-1', {
      afterTabId: undefined,
      targetGroupId: 'group-left',
      command: 'zsh',
      cwd: '/repo/packages/app',
      env: { CODEX_PROFILE: 'captured' },
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
      startupCommandDelivery: undefined,
      agent: undefined,
      launchToken: 'launch-token-123',
      launchConfig: {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      launchAgent: 'codex',
      viewMode: 'chat',
      activate: true,
      select: undefined,
      clientNavigationId: undefined,
      navigation: 'all',
      clientMutationId: undefined,
      signal: undefined
    })
  })

  it('defaults legacy paired terminal creation to caller-owned selection', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: { type: 'terminal', id: 'tab-1::leaf-1' },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        activate: true,
        clientMutationId: 'create-1'
      }),
      () => {},
      { clientKind: 'runtime', pairedDeviceId: 'device-a' }
    )

    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({
        activate: true,
        clientMutationId: 'create-1',
        clientNavigationId: 'device-a',
        navigation: 'caller'
      })
    )
  })

  it('preserves legacy agent creation for mixed-version clients', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Terminal',
          status: 'ready',
          terminal: 'pty-1',
          isActive: true
        },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        agent: 'codex',
        agentPrompt: 'Review this diff'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledWith('id:wt-1', {
      afterTabId: undefined,
      targetGroupId: undefined,
      command: undefined,
      cwd: undefined,
      startupCommandDelivery: undefined,
      agent: 'codex',
      agentPrompt: 'Review this diff',
      activate: undefined,
      select: undefined,
      clientNavigationId: undefined,
      navigation: 'all',
      clientMutationId: undefined,
      signal: undefined
    })
  })

  it('rejects agent prompts without an agent preset', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        agentPrompt: 'Review this diff'
      })
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: 'Agent prompt requires an agent preset' }
    })
    expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('dispatches terminal creation with startup command delivery metadata', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Terminal',
          status: 'ready',
          terminal: 'pty-1',
          isActive: true
        },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        command: "codex 'linked issue context'",
        startupCommandDelivery: 'shell-ready'
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.createMobileSessionTerminal).toHaveBeenCalledWith('id:wt-1', {
      afterTabId: undefined,
      targetGroupId: undefined,
      command: "codex 'linked issue context'",
      startupCommandDelivery: 'shell-ready',
      agent: undefined,
      activate: undefined,
      select: undefined,
      clientNavigationId: undefined,
      navigation: 'all'
    })
  })

  it('rejects unknown agent presets without creating a terminal', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.createTerminal', {
        worktree: 'id:wt-1',
        agent: 'not-real'
      })
    )

    expect(response.ok).toBe(false)
    expect(response).toMatchObject({
      error: { code: 'invalid_argument', message: 'Unknown agent preset' }
    })
    expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })
})
