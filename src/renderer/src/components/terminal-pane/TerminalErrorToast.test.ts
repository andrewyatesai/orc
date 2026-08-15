import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  humanizeTerminalError,
  isExplainedTerminalError,
  isSshReconnectOwnedTerminalError,
  shouldOfferDaemonRestart,
  stripSshReconnectOwnedErrorLines,
  TerminalErrorToast
} from './TerminalErrorToast'

const SSH_FAILURE =
  "SSH connection failed: Error invoking remote method 'ssh:connect': Error: Relay package for linux-x64 not found locally."
// A pre-translation build could still surface the raw named-pipe connect error.
const LEGACY_HOST_GONE =
  "Error invoking remote method 'pty:spawn': Error: connect ENOENT \\\\?\\pipe\\orca-terminal-host-v30-14cb7f94b511"

describe('isSshReconnectOwnedTerminalError', () => {
  it('matches raw ssh:connect failures and inactive-host messages', () => {
    expect(
      isSshReconnectOwnedTerminalError(
        "SSH connection failed: Error invoking remote method 'ssh:connect': Error: Relay package for linux-x64 not found locally."
      )
    ).toBe(true)
    expect(
      isSshReconnectOwnedTerminalError(
        'SSH connection is not active. Use the reconnect dialog or Settings to connect.'
      )
    ).toBe(true)
  })

  it('leaves unrelated terminal errors for the toast', () => {
    expect(isSshReconnectOwnedTerminalError('Paste failed.')).toBe(false)
    expect(isSshReconnectOwnedTerminalError('node-pty: open_slave failed: EMFILE')).toBe(false)
  })
})

describe('stripSshReconnectOwnedErrorLines', () => {
  it('clears an error that is only SSH reconnect text', () => {
    expect(stripSshReconnectOwnedErrorLines(SSH_FAILURE)).toBeNull()
  })

  it('keeps an unrelated error that precedes the SSH failure', () => {
    expect(stripSshReconnectOwnedErrorLines(`Paste failed.\n${SSH_FAILURE}`)).toBe('Paste failed.')
  })

  it('keeps an unrelated error that follows the SSH failure', () => {
    expect(stripSshReconnectOwnedErrorLines(`${SSH_FAILURE}\nPaste failed.`)).toBe('Paste failed.')
  })

  it('drops every SSH-owned line but preserves the rest', () => {
    expect(
      stripSshReconnectOwnedErrorLines(
        `${SSH_FAILURE}\nPaste failed.\nSSH connection is not active. Use the reconnect dialog.`
      )
    ).toBe('Paste failed.')
  })

  it('leaves an error with no SSH text untouched', () => {
    expect(stripSshReconnectOwnedErrorLines('Paste failed.')).toBe('Paste failed.')
  })
})

describe('shouldOfferDaemonRestart', () => {
  it('matches stale daemon node-pty install failures', () => {
    expect(
      shouldOfferDaemonRestart(
        "Daemon's node-pty install is gone (worktree deleted?). Restart Orca. node-pty: posix_spawn failed: ENOENT (errno 2, No such file or directory) - helper='/Applications/Orca.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper'"
      )
    ).toBe(true)
  })

  it('matches stale daemon cwd failures', () => {
    expect(
      shouldOfferDaemonRestart(
        "Daemon's working directory is gone (worktree deleted?). Restart Orca. node-pty: daemon_cwd failed: ENOENT (errno 2, No such file or directory) - cwd='<unavailable>'"
      )
    ).toBe(true)
  })

  it('does not match unrelated terminal spawn errors', () => {
    expect(shouldOfferDaemonRestart('SSH connection is not active.')).toBe(false)
    expect(shouldOfferDaemonRestart('node-pty: open_slave failed: EMFILE (errno 24)')).toBe(false)
  })
})

describe('humanizeTerminalError', () => {
  it('replaces the terminal-host-gone code with copy that explains the loss', () => {
    const humanized = humanizeTerminalError('terminal_host_gone')
    expect(humanized).not.toContain('terminal_host_gone')
    expect(humanized).toContain('Open a new terminal to continue')
  })

  it('humanizes an IPC-wrapped terminal-host-gone error', () => {
    const prefix = "Error invoking remote method 'pty:spawn': Error: ("
    const humanized = humanizeTerminalError(`${prefix}terminal_host_gone).`)
    expect(humanized).not.toContain('terminal_host_gone')
    expect(humanized).toContain(`${prefix}The terminal daemon`)
    expect(humanized).toMatch(/\)\.$/)
  })

  it('humanizes a legacy host raw named-pipe error', () => {
    const humanized = humanizeTerminalError(LEGACY_HOST_GONE)
    expect(humanized).not.toContain('connect ENOENT')
    expect(humanized).not.toContain('orca-terminal-host-v30')
    expect(humanized).toContain('Open a new terminal to continue')
  })

  it('only replaces exact host-gone markers in aggregated errors', () => {
    const humanized = humanizeTerminalError('terminal_host_gone\nterminal_host_gone_extra')
    expect(humanized).toContain('Open a new terminal to continue')
    expect(humanized).toContain('\nterminal_host_gone_extra')
  })

  it.each(['ENOENT', 'ECONNREFUSED'])(
    'does not combine a %s connection failure with a host endpoint on another line',
    (code) => {
      const aggregated =
        `connect ${code} \\\\?\\pipe\\unrelated\n` + 'orca-terminal-host-v30-14cb7f94b511'
      expect(isExplainedTerminalError(aggregated)).toBe(false)
      expect(humanizeTerminalError(aggregated)).toBe(aggregated)
    }
  )

  it('leaves other errors untouched', () => {
    expect(humanizeTerminalError('Paste failed.')).toBe('Paste failed.')
  })
})

describe('isExplainedTerminalError', () => {
  it('suppresses the issue link for a provably dead terminal host', () => {
    expect(isExplainedTerminalError('terminal_host_gone')).toBe(true)
    expect(
      isExplainedTerminalError(
        "Error invoking remote method 'pty:spawn': Error: terminal_host_gone"
      )
    ).toBe(true)
    expect(isExplainedTerminalError(LEGACY_HOST_GONE)).toBe(true)
    expect(
      isExplainedTerminalError('connect ECONNREFUSED /tmp/orca-terminal-host-v30-14cb7f94b511.sock')
    ).toBe(true)
  })

  it('keeps the issue link for errors Orca cannot explain', () => {
    expect(isExplainedTerminalError('Paste failed.')).toBe(false)
    expect(isExplainedTerminalError('node-pty: open_slave failed: EMFILE')).toBe(false)
    expect(isExplainedTerminalError('terminal_gone')).toBe(false)
    expect(isExplainedTerminalError('terminal_host_gone_extra')).toBe(false)
    expect(isExplainedTerminalError('aterminal_host_gone.')).toBe(false)
    expect(isExplainedTerminalError('0terminal_host_gone.')).toBe(false)
    expect(isExplainedTerminalError('_terminal_host_gone.')).toBe(false)
    expect(isExplainedTerminalError('open ENOENT \\\\?\\pipe\\orca-terminal-host-v30-dead')).toBe(
      false
    )
    expect(
      isExplainedTerminalError('connect ETIMEDOUT \\\\?\\pipe\\orca-terminal-host-v30-dead')
    ).toBe(false)
    expect(isExplainedTerminalError('connect ENOENT \\\\?\\pipe\\unrelated')).toBe(false)
  })
})

describe('TerminalErrorToast issue link', () => {
  it('routes local terminal failures to the ALab development issue tracker', () => {
    const html = renderToStaticMarkup(
      createElement(TerminalErrorToast, {
        error: 'Terminal failed to start.',
        onDismiss: () => undefined
      })
    )

    expect(html).toContain('href="https://github.com/andrewyatesai/orca-alab/issues"')
  })

  it('explains a dead terminal host and suppresses the issue link', () => {
    const html = renderToStaticMarkup(
      createElement(TerminalErrorToast, {
        error: 'terminal_host_gone',
        onDismiss: () => undefined
      })
    )

    expect(html).not.toContain('terminal_host_gone')
    expect(html).toContain('Open a new terminal to continue')
    expect(html).not.toContain('href="https://github.com/andrewyatesai/orca-alab/issues"')
  })
})
