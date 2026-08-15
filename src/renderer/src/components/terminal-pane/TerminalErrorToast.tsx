import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { resolveClientEnvironmentFooter } from '@/lib/client-environment-info'
import { hasClientEnvironmentFooter } from '../../../../shared/client-environment-info'
import { ORCA_ALAB_DEVELOPMENT_ISSUES_URL } from '../../../../shared/repository-endpoints'

const SSH_PREFIX = 'SSH connection is not active'
// Produced by pty-connection.ts reportError() when a PTY reattach can't reach its SSH host.
const SSH_CONNECT_FAILURE_PREFIX = 'SSH connection failed'
const STALE_NODE_PTY_DAEMON_MARKERS = [
  "Daemon's node-pty install is gone",
  'node-pty: posix_spawn failed: ENOENT'
]
const STALE_DAEMON_CWD_MARKERS = [
  "Daemon's working directory is gone",
  'node-pty: daemon_cwd failed: ENOENT'
]
// Thrown by ipc/pty.ts (TerminalHostGoneError) when a resume's owning daemon has exited.
// Why one source: the test and replace forms must match the same token, and a lone /g regex carries
// lastIndex state across .test() calls. Capture the leading boundary so replacement can restore it.
const TERMINAL_HOST_GONE_SOURCE = '(^|[^a-z0-9_])terminal_host_gone(?=$|[^a-z0-9_])'
const TERMINAL_HOST_GONE_PATTERN = new RegExp(TERMINAL_HOST_GONE_SOURCE)
const TERMINAL_HOST_GONE_REPLACE_PATTERN = new RegExp(TERMINAL_HOST_GONE_SOURCE, 'g')
// A pre-translation build could leak the raw connect error; the daemon pipe/socket name is stable.
const LEGACY_TERMINAL_HOST_GONE_PATTERN =
  /(^|[^a-z])connect (?:ENOENT|ECONNREFUSED) [^\r\n]*orca-terminal-host-v[^\r\n]*/i

function isSshError(error: string): boolean {
  return error.startsWith(SSH_PREFIX)
}

/** A single error line the SSH reconnect banner already covers — hide instead of stacking under/over it. */
export function isSshReconnectOwnedTerminalError(error: string): boolean {
  return error.startsWith(SSH_CONNECT_FAILURE_PREFIX) || error.startsWith(SSH_PREFIX)
}

// Why: onPtyError aggregates errors into one newline-joined string, so classify per line —
// drop only the reconnect-owned lines and keep any unrelated error, regardless of order.
export function stripSshReconnectOwnedErrorLines(error: string): string | null {
  const kept = error
    .split('\n')
    .filter((line) => !isSshReconnectOwnedTerminalError(line))
    .join('\n')
  return kept.length > 0 ? kept : null
}

export function shouldOfferDaemonRestart(error: string): boolean {
  return [STALE_NODE_PTY_DAEMON_MARKERS, STALE_DAEMON_CWD_MARKERS].some((markers) =>
    markers.every((marker) => error.includes(marker))
  )
}

/** A dead terminal host is unrecoverable, so the toast can fully explain it and drop the issue link. */
export function isExplainedTerminalError(error: string): boolean {
  return error
    .split('\n')
    .some(
      (line) =>
        TERMINAL_HOST_GONE_PATTERN.test(line) || LEGACY_TERMINAL_HOST_GONE_PATTERN.test(line)
    )
}

/** Swaps the raw daemon-boundary host-gone code for copy a user can act on. */
export function humanizeTerminalError(error: string): string {
  if (!isExplainedTerminalError(error)) {
    return error
  }
  const explanation = translate(
    'auto.components.terminal.pane.TerminalErrorToast.e16012e31e',
    'The terminal daemon that owned this session exited, so the session and its scrollback could not be recovered. Open a new terminal to continue.'
  )
  return error
    .split('\n')
    .map((line) =>
      line
        .replace(TERMINAL_HOST_GONE_REPLACE_PATTERN, (_match, prefix: string) =>
          prefix.concat(explanation)
        )
        .replace(LEGACY_TERMINAL_HOST_GONE_PATTERN, (_match, prefix: string) =>
          prefix.concat(explanation)
        )
    )
    .join('\n')
}

export function TerminalErrorToast({
  error,
  onDismiss,
  onRestartDaemon
}: {
  error: string
  onDismiss: () => void
  onRestartDaemon?: () => void
}): React.JSX.Element {
  const ssh = isSshError(error)
  const showDaemonRestart = !ssh && onRestartDaemon && shouldOfferDaemonRestart(error)
  // Restart cannot recover a session after its owning daemon exits, so Orca explains it instead.
  const showIssueLink = !ssh && !showDaemonRestart && !isExplainedTerminalError(error)
  const displayError = humanizeTerminalError(error)
  const [environmentFooter, setEnvironmentFooter] = useState<{
    error: string
    footer: string
  } | null>(null)

  // Why: a select-all copy should carry details loaded asynchronously from preload.
  useEffect(() => {
    if (ssh || hasClientEnvironmentFooter(error)) {
      return
    }
    let cancelled = false
    void resolveClientEnvironmentFooter().then((footer) => {
      if (!cancelled) {
        setEnvironmentFooter({ error, footer })
      }
    })
    return () => {
      cancelled = true
    }
  }, [error, ssh])

  const footer = environmentFooter?.error === error ? environmentFooter.footer : ''

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 12,
        left: 12,
        right: 12,
        zIndex: 50,
        padding: '10px 14px',
        borderRadius: 6,
        background: ssh ? 'rgba(234, 179, 8, 0.12)' : 'rgba(220, 38, 38, 0.15)',
        border: ssh ? '1px solid rgba(234, 179, 8, 0.35)' : '1px solid rgba(220, 38, 38, 0.4)',
        color: ssh ? '#fde68a' : '#fca5a5',
        fontSize: 12,
        fontFamily: 'monospace',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'auto'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <span style={{ minWidth: 0 }}>
          {displayError}
          {showDaemonRestart ? (
            <>
              {'\n'}
              {translate(
                'auto.components.terminal.pane.TerminalErrorToast.cc6d997c65',
                'Restart the terminal daemon from here to clear stale daemon state.'
              )}
            </>
          ) : showIssueLink ? (
            <>
              {'\n'}
              {translate(
                'auto.components.terminal.pane.TerminalErrorToast.5c8ce20be6',
                'If this persists, please'
              )}{' '}
              <a
                href={ORCA_ALAB_DEVELOPMENT_ISSUES_URL}
                style={{ color: '#fca5a5', textDecoration: 'underline' }}
              >
                {translate(
                  'auto.components.terminal.pane.TerminalErrorToast.a7e2fd2699',
                  'file an issue'
                )}
              </a>
              .
            </>
          ) : null}
          {!ssh && footer ? `\n\n${footer}` : null}
        </span>
        {showDaemonRestart ? (
          <button
            onClick={onRestartDaemon}
            style={{
              marginLeft: 12,
              border: '1px solid rgba(252, 165, 165, 0.45)',
              borderRadius: 6,
              background: 'rgba(127, 29, 29, 0.35)',
              color: '#fecaca',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 8px',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            {translate(
              'auto.components.terminal.pane.TerminalErrorToast.e4aa243f8c',
              'Restart daemon'
            )}
          </button>
        ) : null}
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: ssh ? '#fde68a' : '#fca5a5',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 0 0 8px',
            lineHeight: 1,
            flexShrink: 0
          }}
        >
          ×
        </button>
      </div>
    </div>
  )
}
