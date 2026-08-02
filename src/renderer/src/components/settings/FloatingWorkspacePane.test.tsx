import { describe, expect, it } from 'vitest'
import { getFloatingWorkspaceDirectoryInputValue } from './FloatingWorkspacePane'

describe('getFloatingWorkspaceDirectoryInputValue', () => {
  it('shows home shorthand for the default terminal directory', () => {
    expect(
      getFloatingWorkspaceDirectoryInputValue({
        configuredFloatingWorkspacePath: '~',
        resolvedFloatingWorkspacePath: '/userhome/example'
      })
    ).toBe('~')
  })

  it('shows home shorthand for legacy blank terminal directory settings', () => {
    expect(
      getFloatingWorkspaceDirectoryInputValue({
        configuredFloatingWorkspacePath: '',
        resolvedFloatingWorkspacePath: '/userhome/example'
      })
    ).toBe('~')
  })

  it('shows the main-resolved trusted custom directory', () => {
    expect(
      getFloatingWorkspaceDirectoryInputValue({
        configuredFloatingWorkspacePath: '/userhome/example/notes',
        resolvedFloatingWorkspacePath: '/userhome/example/notes'
      })
    ).toBe('/userhome/example/notes')
  })
})
