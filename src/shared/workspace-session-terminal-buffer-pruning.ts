// Terminal-scrollback pruning for persisted workspace sessions, driven by the
// Rust `orca_config::workspace_session_terminal_buffers` core.
//
// It lives on `orca-dispatch-seam` rather than in one tree's binding directory
// because the decision is taken on more than one surface: Electron main's
// persistence store (napi, bound at bootstrap) and the renderer's session
// payload/patch builders (wasm, bound at ready). One shim serves both because
// the fallback below is the answer, not a degrade.
//
// PRE-READY CONTRACT — `parity`, and it is FORCED. Every export decides what
// gets WRITTEN to, or DELETED from, persisted session state, so neither of the
// other two options is honest:
//   * No constant works. All three answers depend on the input (a repo
//     classification, a byte-budget tail, a per-tab prune), which is
//     ported-modules.md case 3. `false`/`true` from the predicate are the two
//     halves of the bug — `false` throws away the only scrollback an SSH pane
//     can cold-restore from, `true` writes megabytes of local scrollback that
//     the daemon's own history already holds — and each is indistinguishable
//     from a real answer.
//   * No sentinel has anywhere to live. `pruneLocalTerminalScrollbackBuffers`
//     returns the session itself; the spare state would have to be "do not
//     persist this write at all", and because
//     `awaitGitWasmReadyForStartupHydration()` gates hydration, a not-ready core
//     post-mount is a FAILED core — that sentinel would mean the renderer never
//     persists a session for the rest of the run. Losing every tab is not a
//     safer failure than pruning correctly.
// So each fallback rebuilds the deleted twin's body verbatim over the data the
// twin still keeps (`FLOATING_TERMINAL_WORKTREE_ID`,
// `TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT`, `parseExecutionHostId`,
// `clampUtf8TextTail`, `WORKTREE_ID_SEPARATOR`) — the same shape
// `worktree-id-parsing` and `terminal-tab-id-validity` use, for the same reason.
//
// The repo id is split from the kept separator INLINE rather than by calling
// `getRepoIdFromWorktreeId`, and that is deliberate: worktree-id's own cut-over
// is mid-flight (`src/shared/worktree-id-parsing.ts` is not in HEAD yet), so
// importing it would compile here and break the committed tree. The expression
// is the same one that shim falls back to, and the Rust half of this module
// calls `orca_core::worktree_id::get_repo_id_from_worktree_id` itself.
//
// Measured, not asserted: `tools/parity/dispatch/workspace-session-terminal-buffers.ts`
// drives THIS shim, and `config/vitest.parity.config.ts` installs no setup file,
// so `pnpm parity` runs the fallback against the core over the whole vector
// corpus — a real fallback-vs-Rust differential, not a self-comparison. The
// ready half is pinned by the rows in
// `src/renderer/src/lib/git-wasm/shim-pre-ready-contract.test.ts`, which call
// each export before and after the wasm initialises.
//
// TWO DELIBERATE CONFLATIONS, both declared rather than hidden:
//  1. `undefinedProperties: 'omit'`. A renderer session payload is built with
//     explicit `undefined` values (`remoteSessionIdsByTabId`,
//     `defaultTerminalTabsAppliedByWorktreeId`, …), and rejecting them would
//     send every real renderer prune down the fallback. For this module absent
//     ≡ undefined: the result is either JSON-persisted (where `JSON.stringify`
//     drops the key anyway) or read by property access. Audited at all five
//     call sites — persistence.ts assigns the result, terminal-scrollback-
//     snapshots.ts takes a string, workspace-session-patch.ts reads one field,
//     workspace-session.ts sends the payload over IPC where `session:set`
//     REPLACES rather than merges. None uses `in`, `Object.keys`, or the result
//     as a spread OVERLAY, which is the one place a dropped key would differ.
//  2. Only the two fields the core reads cross the boundary. `prune_local_
//     terminal_scrollback_buffers` reads `tabsByWorktree` and
//     `terminalLayoutsByTabId` and copies every other key of the session
//     verbatim (pinned by the `extra top-level session keys` vector), so this
//     shim sends that slice and re-attaches the answer. Crossing the whole
//     document instead would put editor drafts and browser history through the
//     codec — one lone surrogate in an unsaved buffer would push the prune onto
//     the fallback forever, for no change in the answer.
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { DispatchPayloadError } from './dispatch-payload-codec'
import { parseExecutionHostId } from './execution-host'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from './terminal-scrollback-limits'
import type { WorkspaceSessionState } from './types'
import { clampUtf8TextTail, measureUtf8ByteLength } from './utf8-byte-limits'
import type { RepoConnection } from './workspace-session-terminal-buffers'
import { WORKTREE_ID_SEPARATOR } from './worktree-id'

export type { RepoConnection } from './workspace-session-terminal-buffers'

const DISPATCH_MODULE = 'workspace-session-terminal-buffers'

type TerminalLayoutsByTabId = WorkspaceSessionState['terminalLayoutsByTabId']
type RepoTerminalScrollbackOwner = Pick<RepoConnection, 'connectionId' | 'executionHostId'>

/** Project to the three fields `parse_repos` reads: a whole Repo record carries
 *  paths and user text that could refuse to encode and take the fallback for no
 *  gain. `undefined` becomes `null` because both mean "absent" to the core. */
function toDispatchRepos(
  repos: readonly RepoConnection[]
): { id: string; connectionId: string | null; executionHostId: string | null }[] {
  return repos.map((repo) => ({
    id: repo.id,
    connectionId: repo.connectionId ?? null,
    executionHostId: repo.executionHostId ?? null
  }))
}

/**
 * Dispatch, or answer `null` for "take the parity fallback".
 *
 * Two causes collapse into that `null` and both are safe here because the
 * fallback is the twin's body: no binding yet (renderer before wasm), and a
 * payload the codec refuses. The refusal is real for this module — persisted
 * scrollback is raw terminal output, and a Windows path or a half-decoded PTY
 * write can carry an unpaired UTF-16 surrogate, which is not valid UTF-8 and
 * cannot cross at all. The twin answered such a buffer without crossing
 * anything, so the fallback IS that answer. A `DispatchCoreError` still
 * propagates: the core was reached and failed, which is a bug, not a degrade.
 *
 * No `null` returned by the core is mistaken for this signal — every arm of the
 * Rust module answers with a bool, a string, or an object.
 */
function dispatchOrFallback(fn: string, input: unknown, root: string): unknown | null {
  try {
    return tryOrcaDispatch(DISPATCH_MODULE, fn, input, { undefinedProperties: 'omit', root })
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

export function shouldPreserveTerminalScrollbackBuffers(
  worktreeId: string | undefined,
  repos: readonly RepoConnection[]
): boolean {
  const answer = dispatchOrFallback(
    'shouldPreserveTerminalScrollbackBuffers',
    { worktreeId, repos: toDispatchRepos(repos) },
    'worktree'
  )
  return answer === null
    ? legacyShouldPreserveTerminalScrollbackBuffers(worktreeId, repos)
    : (answer as boolean)
}

export function capTerminalScrollbackSessionBuffer(
  buffer: string,
  byteLimit: number = TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT
): string {
  const answer = dispatchOrFallback(
    'capTerminalScrollbackSessionBuffer',
    { buffer, byteLimit },
    'buffer'
  )
  return answer === null
    ? legacyCapTerminalScrollbackSessionBuffer(buffer, byteLimit)
    : (answer as string)
}

export function pruneLocalTerminalScrollbackBuffers(
  session: WorkspaceSessionState,
  repos: readonly RepoConnection[],
  // Why an override exists: callers that immediately migrate buffers into disk
  // snapshot refs (P5 store, 5MB) may keep more than the session-JSON bound;
  // callers whose buffers stay durably in JSON must use the default.
  opts: { bufferByteLimit?: number } = {}
): WorkspaceSessionState {
  const bufferByteLimit = opts.bufferByteLimit ?? TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT
  const answer = dispatchOrFallback(
    'pruneLocalTerminalScrollbackBuffers',
    {
      session: {
        tabsByWorktree: session.tabsByWorktree,
        terminalLayoutsByTabId: session.terminalLayoutsByTabId
      },
      repos: toDispatchRepos(repos),
      opts: { bufferByteLimit }
    },
    'session'
  )
  if (answer === null) {
    return legacyPruneLocalTerminalScrollbackBuffers(session, repos, bufferByteLimit)
  }
  const terminalLayoutsByTabId = (answer as { terminalLayoutsByTabId?: TerminalLayoutsByTabId })
    .terminalLayoutsByTabId
  // A legacy session with no layouts map comes back untouched, as the core leaves it.
  return terminalLayoutsByTabId === undefined
    ? session
    : {
        ...session,
        // Why: local daemon history/checkpoints are authoritative for restart
        // scrollback. Keeping renderer-captured buffers for local tabs makes every
        // persisted state write scale with old terminal output; remote/runtime tabs
        // keep them because teardown may leave no local history to cold-restore.
        terminalLayoutsByTabId
      }
}

function repoNeedsRendererCapturedScrollback(repo: RepoTerminalScrollbackOwner): boolean {
  if (repo.connectionId) {
    return true
  }
  const parsedHost = parseExecutionHostId(repo.executionHostId)
  return parsedHost !== null && parsedHost.kind !== 'local'
}

function legacyShouldPreserveForRepoMap(
  worktreeId: string | undefined,
  repoById: ReadonlyMap<string, RepoTerminalScrollbackOwner>
): boolean {
  if (worktreeId === undefined || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return false
  }
  const separatorIdx = worktreeId.indexOf(WORKTREE_ID_SEPARATOR)
  const repoId = separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
  const repo = repoById.get(repoId)
  if (repo && repoNeedsRendererCapturedScrollback(repo)) {
    return true
  }
  if (!repoById.has(repoId)) {
    // Why: when the repo catalog is not hydrated, treating the worktree as
    // remote avoids losing the only scrollback source a relay/runtime terminal
    // may have.
    return true
  }
  return false
}

function legacyShouldPreserveTerminalScrollbackBuffers(
  worktreeId: string | undefined,
  repos: readonly RepoConnection[]
): boolean {
  return legacyShouldPreserveForRepoMap(
    worktreeId,
    new Map(repos.map((repo) => [repo.id, repo] as const))
  )
}

function legacyCapTerminalScrollbackSessionBuffer(buffer: string, byteLimit: number): string {
  if (
    buffer.length <= byteLimit &&
    !measureUtf8ByteLength(buffer, { stopAfterBytes: byteLimit }).exceededLimit
  ) {
    return buffer
  }
  return clampUtf8TextTail(buffer, byteLimit).text
}

function legacyCapLeafBuffers(
  buffers: Record<string, string> | undefined,
  byteLimit: number
): {
  buffers: Record<string, string> | undefined
  changed: boolean
} {
  if (!buffers) {
    return { buffers: undefined, changed: false }
  }
  let changed = false
  const capped: Record<string, string> = {}
  for (const [leafId, buffer] of Object.entries(buffers)) {
    const next = legacyCapTerminalScrollbackSessionBuffer(buffer, byteLimit)
    capped[leafId] = next
    changed ||= next !== buffer
  }
  return { buffers: Object.keys(capped).length > 0 ? capped : undefined, changed }
}

function legacyPruneLocalTerminalScrollbackBuffers(
  session: WorkspaceSessionState,
  repos: readonly RepoConnection[],
  bufferByteLimit: number
): WorkspaceSessionState {
  const repoById = new Map(repos.map((repo) => [repo.id, repo] as const))
  const worktreeIdByTabId = new Map<string, string>()
  const tabsByWorktree = session.tabsByWorktree ?? {}
  const terminalLayoutsByTabIdForRead = session.terminalLayoutsByTabId ?? {}
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }

  let terminalLayoutsByTabId: TerminalLayoutsByTabId | null = null
  for (const [tabId, layout] of Object.entries(terminalLayoutsByTabIdForRead)) {
    if (!layout.buffersByLeafId && !layout.scrollbackRefsByLeafId) {
      continue
    }
    const worktreeId = worktreeIdByTabId.get(tabId)
    if (legacyShouldPreserveForRepoMap(worktreeId, repoById)) {
      const capped = legacyCapLeafBuffers(layout.buffersByLeafId, bufferByteLimit)
      if (capped.changed) {
        terminalLayoutsByTabId ??= { ...terminalLayoutsByTabIdForRead }
        terminalLayoutsByTabId[tabId] = { ...layout, buffersByLeafId: capped.buffers }
      }
      continue
    }

    terminalLayoutsByTabId ??= { ...terminalLayoutsByTabIdForRead }
    const layoutWithoutBuffers = { ...layout }
    delete layoutWithoutBuffers.buffersByLeafId
    delete layoutWithoutBuffers.scrollbackRefsByLeafId
    terminalLayoutsByTabId[tabId] = layoutWithoutBuffers
  }

  if (!terminalLayoutsByTabId) {
    return session
  }

  return { ...session, terminalLayoutsByTabId }
}
