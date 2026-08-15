// TS dispatch for the workspace-session-terminal-buffers parity module: maps the
// shared vector function names to the real
// `src/shared/workspace-session-terminal-buffers.ts` exports so the harness
// compares the live TS reference against the Rust port.

import {
  capTerminalScrollbackSessionBuffer,
  pruneLocalTerminalScrollbackBuffers,
  shouldPreserveTerminalScrollbackBuffers,
  type RepoConnection
} from '../../../src/shared/workspace-session-terminal-buffers'
import type { WorkspaceSessionState } from '../../../src/shared/types'

/** JSON has no `undefined`, so an absent-or-null limit selects the TS default
 *  parameter. The Rust adapter applies the same rule — JS `null` would coerce to
 *  0 instead of defaulting, which no caller wants and no vector exercises. */
function optionalLimit(value: number | null | undefined): number | undefined {
  return value ?? undefined
}

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'shouldPreserveTerminalScrollbackBuffers': {
      const { worktreeId, repos } = input as {
        worktreeId?: string
        repos: RepoConnection[]
      }
      return shouldPreserveTerminalScrollbackBuffers(worktreeId, repos)
    }
    case 'capTerminalScrollbackSessionBuffer': {
      const { buffer, byteLimit } = input as { buffer: string; byteLimit?: number | null }
      const limit = optionalLimit(byteLimit)
      return limit === undefined
        ? capTerminalScrollbackSessionBuffer(buffer)
        : capTerminalScrollbackSessionBuffer(buffer, limit)
    }
    case 'pruneLocalTerminalScrollbackBuffers': {
      const { session, repos, opts } = input as {
        session: WorkspaceSessionState
        repos: RepoConnection[]
        opts?: { bufferByteLimit?: number | null }
      }
      // Why the third argument is omitted rather than passed as `{}`: the
      // twin-derived harness infers the vector encoding from the arguments the
      // adapter actually passes, and a phantom `opts` on every legacy vector
      // makes the named-argument convention unmatchable — which drops the
      // module's derived cases instead of reporting them.
      const limit = optionalLimit(opts?.bufferByteLimit)
      return limit === undefined
        ? pruneLocalTerminalScrollbackBuffers(session, repos)
        : pruneLocalTerminalScrollbackBuffers(session, repos, { bufferByteLimit: limit })
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
