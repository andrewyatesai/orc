import { describe, expect, it } from 'vitest'
import {
  bindOrcaCliPaneIdentity,
  ORCA_CLI_PANE_TOKEN_PARAM,
  RELAY_PANE_TOKEN_ENV,
  RelayPaneCliAttribution
} from './orca-cli-pane-attribution'

// The attack this file is about: the `orca` shim runs on the remote machine, so
// everything it sends is chosen by the remote account — including which pane the
// call claims to be. ORCA_PANE_KEY is pane authority on the host, so a caller
// that picks its own is acting as a pane in a worktree it may never have had.

const PANE_A_ENV = {
  ORCA_PANE_KEY: 'tab-a:leaf-a',
  ORCA_WORKTREE_ID: 'repo-1::/home/alice/wt-a',
  ORCA_TERMINAL_HANDLE: 'term_a',
  ORCA_WORKSPACE_ID: 'repo-1::/home/alice/wt-a'
}

const PANE_B_ENV = {
  ORCA_PANE_KEY: 'tab-b:leaf-b',
  ORCA_WORKTREE_ID: 'repo-2::/home/alice/wt-b',
  ORCA_TERMINAL_HANDLE: 'term_b',
  ORCA_WORKSPACE_ID: 'repo-2::/home/alice/wt-b'
}

function issueToken(
  attribution: RelayPaneCliAttribution,
  ptyId: string,
  paneEnv: Record<string, string>
): string {
  return attribution.issue(ptyId, paneEnv)[RELAY_PANE_TOKEN_ENV]
}

function callAs(token: string | undefined, claimedEnv: Record<string, unknown>) {
  return {
    argv: ['terminal', 'send', '--worktree', 'active'],
    cwd: '/home/alice/wt-a',
    env: claimedEnv,
    ...(token !== undefined ? { [ORCA_CLI_PANE_TOKEN_PARAM]: token } : {})
  }
}

describe('RelayPaneCliAttribution', () => {
  it('seeds a distinct token per pane and resolves each to its own identity', () => {
    const attribution = new RelayPaneCliAttribution()
    const tokenA = issueToken(attribution, 'pty-1', PANE_A_ENV)
    const tokenB = issueToken(attribution, 'pty-2', PANE_B_ENV)

    expect(tokenA).not.toBe(tokenB)
    expect(attribution.resolve(tokenA)).toEqual({
      paneKey: 'tab-a:leaf-a',
      worktreeId: 'repo-1::/home/alice/wt-a',
      terminalHandle: 'term_a',
      workspaceId: 'repo-1::/home/alice/wt-a'
    })
    expect(attribution.resolve(tokenB)?.paneKey).toBe('tab-b:leaf-b')
  })

  it('resolves nothing for a token it never issued, whatever its shape', () => {
    const attribution = new RelayPaneCliAttribution()
    issueToken(attribution, 'pty-1', PANE_A_ENV)

    for (const forged of ['f'.repeat(64), '', undefined, null, 42, { toString: () => 'x' }, []]) {
      expect(attribution.resolve(forged)).toBeNull()
    }
  })

  it('stops attributing a pane once its PTY is gone', () => {
    const attribution = new RelayPaneCliAttribution()
    const token = issueToken(attribution, 'pty-1', PANE_A_ENV)

    attribution.release('pty-1')

    expect(attribution.resolve(token)).toBeNull()
  })

  it('revokes the previous token when a PTY id is re-issued (revive)', () => {
    const attribution = new RelayPaneCliAttribution()
    const first = issueToken(attribution, 'pty-1', PANE_A_ENV)
    const second = issueToken(attribution, 'pty-1', PANE_A_ENV)

    expect(second).not.toBe(first)
    expect(attribution.resolve(first)).toBeNull()
    expect(attribution.resolve(second)?.paneKey).toBe('tab-a:leaf-a')
  })
})

describe('bindOrcaCliPaneIdentity', () => {
  it('honors the pane the caller can prove, not the one it names', () => {
    const attribution = new RelayPaneCliAttribution()
    const tokenA = issueToken(attribution, 'pty-1', PANE_A_ENV)
    issueToken(attribution, 'pty-2', PANE_B_ENV)

    // Pane A's shim, claiming to be pane B in another worktree.
    const bound = bindOrcaCliPaneIdentity(callAs(tokenA, { ...PANE_B_ENV }), attribution)

    expect(bound.params.identity).toEqual({
      paneKey: 'tab-a:leaf-a',
      worktreeId: 'repo-1::/home/alice/wt-a',
      terminalHandle: 'term_a',
      workspaceId: 'repo-1::/home/alice/wt-a'
    })
    expect(bound.rejectedPaneKey).toBe('tab-b:leaf-b')
    // The claimed copy must not survive anywhere the host might still read it.
    expect(bound.params.env).toEqual({})
  })

  it('gives an unprovable caller no pane identity at all', () => {
    const attribution = new RelayPaneCliAttribution()
    issueToken(attribution, 'pty-1', PANE_A_ENV)

    const bound = bindOrcaCliPaneIdentity(callAs('f'.repeat(64), { ...PANE_A_ENV }), attribution)

    expect(bound.params.identity).toEqual({})
    expect(bound.params.env).toEqual({})
    expect(bound.rejectedPaneKey).toBe('tab-a:leaf-a')
  })

  it('keeps a legitimate call intact', () => {
    const attribution = new RelayPaneCliAttribution()
    const tokenA = issueToken(attribution, 'pty-1', PANE_A_ENV)

    const bound = bindOrcaCliPaneIdentity(
      callAs(tokenA, { ...PANE_A_ENV, PATH: '/usr/bin' }),
      attribution
    )

    expect(bound.rejectedPaneKey).toBeUndefined()
    expect(bound.params.identity).toMatchObject({ paneKey: 'tab-a:leaf-a' })
    expect(bound.params.argv).toEqual(['terminal', 'send', '--worktree', 'active'])
    expect(bound.params.cwd).toBe('/home/alice/wt-a')
    expect(bound.params.env).toEqual({ PATH: '/usr/bin' })
  })

  it('does not forward the pane credential past the check', () => {
    const attribution = new RelayPaneCliAttribution()
    const tokenA = issueToken(attribution, 'pty-1', PANE_A_ENV)

    const bound = bindOrcaCliPaneIdentity(callAs(tokenA, {}), attribution)

    expect(bound.params[ORCA_CLI_PANE_TOKEN_PARAM]).toBeUndefined()
    expect(JSON.stringify(bound.params)).not.toContain(tokenA)
  })

  it('tolerates a payload with no env object', () => {
    const attribution = new RelayPaneCliAttribution()
    const tokenA = issueToken(attribution, 'pty-1', PANE_A_ENV)

    const bound = bindOrcaCliPaneIdentity(
      { argv: ['status'], cwd: '/', env: 'not-an-object', [ORCA_CLI_PANE_TOKEN_PARAM]: tokenA },
      attribution
    )

    expect(bound.params.env).toEqual({})
    expect(bound.params.identity).toMatchObject({ paneKey: 'tab-a:leaf-a' })
  })
})
