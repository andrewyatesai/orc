import { describe, expect, it } from 'vitest'
import { pickRemoteCliEnv } from './remote-cli-env'

describe('pickRemoteCliEnv', () => {
  it('forwards remote CLI context without any pane-identity var', () => {
    expect(
      pickRemoteCliEnv({
        // Pane authority: the host takes these from the relay's attribution of
        // the calling PTY, so shipping the caller's copy would only offer it a
        // pane to impersonate.
        ORCA_TERMINAL_HANDLE: 'term_ssh',
        ORCA_WORKTREE_ID: 'repo::remote',
        ORCA_PANE_KEY: 'pane-1',
        ORCA_WORKSPACE_ID: 'workspace-1',
        ORCA_USER_DATA_PATH: '/tmp/orca',
        PATH: '/usr/bin',
        SECRET_TOKEN: 'nope'
      })
    ).toEqual({
      ORCA_USER_DATA_PATH: '/tmp/orca',
      PATH: '/usr/bin'
    })
  })
})
