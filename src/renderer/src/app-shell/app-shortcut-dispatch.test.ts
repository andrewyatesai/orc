// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { dispatchAppCommand } from '@/lib/app-command-dispatch'
import { createAppCommandHandlers } from './app-command-handlers'
import {
  dispatchAppShortcut,
  type AppShortcutActions,
  type AppShortcutState,
  type ShortcutDispatchInput
} from './app-shortcut-dispatch'

const executePluginCommand = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/lib/plugin-command-execution', () => ({ executePluginCommand }))

const actions = {
  showRightSidebarSearch: vi.fn(),
  showRightSidebarFiles: vi.fn(),
  toggleSidebar: vi.fn(),
  toggleRightSidebar: vi.fn(),
  setRightSidebarTab: vi.fn(),
  setRightSidebarOpen: vi.fn(),
  openDiffNotesSendMenuForActiveWorktree: vi.fn().mockReturnValue(false)
} as unknown as AppShortcutActions

// Why platform-neutral chords: shortcutPlatform is derived from the user agent, so a `Mod+` binding
// would resolve to a different physical key depending on where the suite runs.
const state = (overrides: Partial<AppShortcutState> = {}): AppShortcutState => ({
  activeView: 'terminal',
  activeWorktreeId: 'worktree-1',
  actions,
  floatingTerminalEnabled: false,
  floatingTerminalOpen: false,
  floatingVisibleTabCount: 0,
  keybindings: {
    'sidebar.left.toggle': ['Alt+Shift+B'],
    'view.tasks': ['Alt+Shift+K']
  },
  terminalShortcutPolicy: 'orca-first',
  setFloatingTerminalOpenWithFocus: vi.fn(),
  workspaceChromeActive: true,
  creationLayoutActive: false,
  ...overrides
})

const input = (overrides: Partial<ShortcutDispatchInput> = {}): ShortcutDispatchInput => ({
  key: 'B',
  code: 'KeyB',
  altKey: true,
  metaKey: false,
  ctrlKey: false,
  shiftKey: true,
  target: document.body,
  defaultPrevented: false,
  preventDefault: vi.fn(),
  ...overrides
})

const pluginCommand: ActivePluginCommand = {
  pluginKey: 'orca-samples.tasks',
  pluginName: 'Tasks',
  id: 'open',
  title: 'Open Tasks',
  context: 'global',
  handler: { type: 'command', command: 'noop' },
  keybindings: [{ key: 'Alt+Shift+B', when: 'global' }]
} as unknown as ActivePluginCommand

beforeEach(() => {
  vi.clearAllMocks()
})

describe('dispatchAppShortcut', () => {
  it('routes a built-in chord through the shared command handlers', () => {
    const event = input()

    dispatchAppShortcut(state(), event, [])

    expect(actions.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('runs a plugin-declared chord instead of the built-in it shadows', () => {
    const event = input()

    dispatchAppShortcut(state(), event, [pluginCommand])

    expect(executePluginCommand).toHaveBeenCalledWith(pluginCommand, 'plugin-keybinding')
    // Plugin chords win over built-in defaults in app focus, so the built-in must not also fire.
    expect(actions.toggleSidebar).not.toHaveBeenCalled()
  })

  it('leaves plugin chords to the terminal when focus is in a terminal', () => {
    const terminalTarget = document.createElement('textarea')
    terminalTarget.className = 'xterm-helper-textarea'
    document.body.append(terminalTarget)

    dispatchAppShortcut(state(), input({ target: terminalTarget }), [pluginCommand])

    expect(executePluginCommand).not.toHaveBeenCalled()
    terminalTarget.remove()
  })
})

describe('createAppCommandHandlers', () => {
  it('reports whether a guarded action claimed the command', () => {
    const handlers = createAppCommandHandlers(state({ activeView: 'settings' }))

    // Settings suppresses the right sidebar, so the alias must decline rather than silently no-op.
    expect(handlers.get('sidebar.right.toggle')?.()).toBe(false)
    expect(handlers.get('sidebar.left.toggle')?.()).toBe(true)
    expect(actions.toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('stays inert for an action with no registered dispatcher', () => {
    expect(dispatchAppCommand('sidebar.left.toggle', 'plugin-palette')).toBe(false)
  })
})
