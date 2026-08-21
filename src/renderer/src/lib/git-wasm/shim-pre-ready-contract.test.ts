// The pre-ready contract gate for the git-wasm shims — the workspace, worktree
// and terminal IDENTITY and PATH rows: id parsing and minting, cross-platform
// and WSL path resolution, native file-drop routing, scrollback-buffer pruning,
// workspace-name slugs, and the setup-runner command paths.
//
// The rule and the snapshot machinery live in
// ./shim-pre-ready-contract-harness.ts; the rest of the row catalog is split by
// domain across the sibling shim-pre-ready-contract-*.test.ts files.
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../../../shared/cross-platform-path-resolution'
import {
  hasNativeFileDragTypes,
  resolveNativeFileDropPath
} from '../../../../shared/native-file-drop-routing'
import { getSetupRunnerCommandPlatformForPath } from './setup-runner-command-platform'
import {
  buildSetupRunnerCommand,
  isWslUncPath as isSetupRunnerWslUncPath,
  resolveSetupRunnerCommand
} from '../../../../shared/setup-runner-command-resolution'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from './terminal-surface-id'
import { isValidHostTerminalTabId, isValidTerminalTabId } from './terminal-tab-id'
import { slugifyForWorkspaceName } from './workspace-name'
import {
  capTerminalScrollbackSessionBuffer,
  pruneLocalTerminalScrollbackBuffers,
  shouldPreserveTerminalScrollbackBuffers
} from '../../../../shared/workspace-session-terminal-buffer-pruning'
import {
  getRepoIdFromWorktreeId,
  getWorktreePathBasenameFromId,
  splitWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../shared/worktree-id-parsing'
import {
  foldWslUncPathCaseInsensitiveParts,
  isWslUncPath,
  mapPosixPathToWslWorktreeUncPath,
  parseWslUncPath,
  toWindowsWslPath
} from '../../../../shared/wsl-unc-paths'
import { runShimPreReadyContractSuite } from './shim-pre-ready-contract-harness'
import type { PreReadyCase } from './shim-pre-ready-contract-harness'

const CASES: PreReadyCase[] = [
  // All three branches of the resolver, because the fallback reproduces the
  // twin's body rather than a constant. Parity is mandatory and a sentinel is
  // impossible: the two-member union has no spare state, and the answer picks the
  // SHELL that executes the setup runner — a wrong 'windows' types
  // `cmd.exe /c "/home/…/run.sh"` at a bash prompt.
  {
    name: 'setup-runner-command-platform.getSetupRunnerCommandPlatformForPath (windows-absolute)',
    call: () =>
      getSetupRunnerCommandPlatformForPath('C:\\repo\\.git\\orca\\setup-runner.cmd', 'posix'),
    contract: {
      kind: 'parity',
      why: 'the fallback re-runs isWindowsAbsolutePathLike inline, exactly as the deleted twin did'
    }
  },
  {
    name: 'setup-runner-command-platform.getSetupRunnerCommandPlatformForPath (posix-absolute)',
    call: () =>
      getSetupRunnerCommandPlatformForPath('/remote/repo/.git/orca/setup-runner.sh', 'windows'),
    contract: {
      kind: 'parity',
      why: "the fallback keeps the twin's leading-slash branch, which outranks the caller fallback"
    }
  },
  {
    name: 'setup-runner-command-platform.getSetupRunnerCommandPlatformForPath (caller fallback)',
    call: () => getSetupRunnerCommandPlatformForPath('orca/setup-runner.sh', 'windows'),
    contract: {
      kind: 'parity',
      why: 'a relative path returns the caller-supplied platform unchanged, in Rust and in the fallback'
    }
  },
  // The command the platform above only picks the shell FOR. Parity is forced
  // for the same reason and one step harder: this string is typed into a live
  // shell and runs, and `runnerScriptPathForShell` is what setup-agent-sequencing
  // appends `.<nonce>.done` to, so a pre-ready spelling the shell disagrees with
  // makes the startup gate wait out its two-hour timeout.
  {
    name: 'setup-runner-command-resolution.buildSetupRunnerCommand (git-bash delivery)',
    call: () =>
      buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', 'posix'),
    contract: {
      kind: 'parity',
      why: 'the fallback is the deleted twin verbatim — measured equal to the core over 1,853,544 inputs'
    }
  },
  {
    name: 'setup-runner-command-resolution.resolveSetupRunnerCommand (wsl unc rewrite)',
    call: () =>
      resolveSetupRunnerCommand(
        '\\\\wsl.localhost\\Ubuntu\\home\\jin\\run.sh',
        'windows',
        'nushell'
      ),
    contract: {
      kind: 'parity',
      why: 'the UNC branch outranks the shell family in both states, so the marker path stays the Linux one'
    }
  },
  {
    name: 'setup-runner-command-resolution.isWslUncPath (no distro segment)',
    call: () => isSetupRunnerWslUncPath('//wsl.localhost/'),
    contract: {
      kind: 'parity',
      why: "this module's predicate accepts an empty distro where wsl-paths' rejects it — the fallback keeps that difference"
    }
  },
  {
    name: 'workspace-name.slugifyForWorkspaceName',
    call: () => slugifyForWorkspaceName('My Thing'),
    contract: {
      kind: 'divergence',
      consequence: '\'\' is indistinguishable from "no usable name", so the create form seeds blank'
    }
  },
  {
    name: 'terminal-surface-id.toWebTerminalSurfaceTabId',
    call: () => toWebTerminalSurfaceTabId('host-tab-1::leaf-9'),
    contract: {
      kind: 'parity',
      why: 'the fallback re-encodes inline from the kept prefix constant — required, this value keys the tab store and feeds makePaneKey()'
    }
  },
  {
    name: 'terminal-surface-id.toHostSessionTabId(wrapped)',
    call: () => toHostSessionTabId('web-terminal-host-tab-1%3A%3Aleaf-9'),
    contract: {
      kind: 'parity',
      why: 'the fallback is the twin body verbatim — orphan recovery reaps surfaces whose host key does not match, so no sentinel is survivable'
    }
  },
  {
    name: 'terminal-surface-id.toHostSessionTabId(non-prefixed)',
    call: () => toHostSessionTabId('host-tab::leaf'),
    contract: { kind: 'parity', why: 'a non-prefixed id passes through unchanged in both states' }
  },
  {
    name: 'terminal-surface-id.isWebTerminalSurfaceTabId',
    call: () => isWebTerminalSurfaceTabId('web-terminal-abc'),
    contract: {
      kind: 'parity',
      why: 'the fallback is the prefix test itself over the kept constant, so the predicate cannot answer false pre-ready'
    }
  },
  {
    // NOT a pre-ready defect: pre-ready is the twin's answer. This pins the
    // READY side — a port divergence already recorded as `allowDivergence` in
    // tools/parity/vectors/terminal-surface-id.json. On a malformed escape the
    // TS catch returned the WHOLE tabId; orca_core::terminal_surface_id returns
    // the decoded slice. Unreachable for ids minted by
    // toWebTerminalSurfaceTabId (encodeURIComponent output always decodes).
    name: 'terminal-surface-id.toHostSessionTabId("web-terminal-%zz")',
    call: () => toHostSessionTabId('web-terminal-%zz'),
    contract: {
      kind: 'divergence',
      consequence:
        'the Rust core drops the prefix ("%zz") where the twin returned "web-terminal-%zz"; both are non-matching host ids, so a malformed mirrored id is reaped by orphan recovery either way'
    }
  },
  {
    name: 'terminal-tab-id.isValidTerminalTabId("plain-tab")',
    call: () => isValidTerminalTabId('plain-tab'),
    contract: {
      kind: 'parity',
      why: 'the fallback is the twin body over the kept delimiter constant — no sentinel exists for a boolean consumed inside `&&`/`.filter`, and a wrong answer re-keys a live tab'
    }
  },
  {
    name: 'terminal-tab-id.isValidTerminalTabId("host-tab::leaf")',
    call: () => isValidTerminalTabId('host-tab::leaf'),
    contract: {
      kind: 'parity',
      why: 'the rejecting direction too: tabs-hydration must drop a colon-bearing persisted id pre-ready exactly as ready'
    }
  },
  {
    name: 'terminal-tab-id.isValidHostTerminalTabId("web-terminal-abc")',
    call: () => isValidHostTerminalTabId('web-terminal-abc'),
    contract: {
      kind: 'parity',
      why: 'the fallback composes the same prefix test — createTab must not adopt a renderer-local surface id as a host tab hint in either state'
    }
  },
  {
    name: 'terminal-tab-id.isValidHostTerminalTabId("plain-tab")',
    call: () => isValidHostTerminalTabId('plain-tab'),
    contract: {
      kind: 'parity',
      why: 'the accepting direction: a pre-ready false would make createTab mint a fresh UUID and orphan the host PTY binding'
    }
  },
  // Parity is mandatory for both, and a sentinel is impossible for either. The
  // real consumer is src/preload/index.ts, which can bind NEITHER binding, so
  // its seam stays unbound for the whole session — the fallback is the behaviour
  // of every OS file drop. hasNativeFileDragTypes is a bare boolean consumed
  // inside `if (!…) return`, and resolveNativeFileDropPath's `null` is a real
  // answer ("no surface claimed it" → an editor drop).
  {
    name: 'native-file-drop-routing.hasNativeFileDragTypes(["Files"])',
    call: () => hasNativeFileDragTypes(['Files']),
    contract: {
      kind: 'parity',
      why: 'the fallback is the twin body over the kept internal-drag-type constant — a pre-ready false would make the preload dragover handler ignore every native drag'
    }
  },
  {
    name: 'native-file-drop-routing.hasNativeFileDragTypes(internal move)',
    call: () => hasNativeFileDragTypes(['Files', 'text/x-orca-file-path']),
    contract: {
      kind: 'parity',
      why: "the rejecting direction: a pre-ready true would hijack Orca's own file-explorer→terminal drags away from their React handlers"
    }
  },
  {
    name: 'native-file-drop-routing.resolveNativeFileDropPath(terminal + leaf)',
    call: () =>
      resolveNativeFileDropPath([
        { terminalPaneLeafId: 'leaf-9' },
        { nativeFileDropTarget: 'terminal', terminalTabId: 'tab-1' }
      ]),
    contract: {
      kind: 'parity',
      why: 'paneLeafId is UNPORTED (orca_core has no such entry field) so the shim composes it on both paths — without it a drop on one split pastes into the active pane instead'
    }
  },
  {
    name: 'native-file-drop-routing.resolveNativeFileDropPath(nearest explorer dir)',
    call: () =>
      resolveNativeFileDropPath([
        { nativeFileDropDir: '/repo/src' },
        { nativeFileDropTarget: 'file-explorer', nativeFileDropDir: '/repo' }
      ]),
    contract: {
      kind: 'parity',
      why: 'the destination dir is the write target for the dropped files, so an innermost-vs-outermost difference would copy them into the wrong folder'
    }
  },
  {
    name: 'native-file-drop-routing.resolveNativeFileDropPath(explorer, no dir)',
    call: () => resolveNativeFileDropPath([{ nativeFileDropTarget: 'file-explorer' }]),
    contract: {
      kind: 'parity',
      why: 'the fail-closed branch: `rejected` drops the gesture, where a pre-ready null would fall through to the editor default and open the files instead'
    }
  },
  {
    name: 'native-file-drop-routing.resolveNativeFileDropPath(unclaimed)',
    call: () => resolveNativeFileDropPath([{ nativeFileDropDir: '/repo' }]),
    contract: {
      kind: 'parity',
      why: "null here is the twin's real answer for this input, not a signal — createNativeFileDropPayload turns it into the editor drop"
    }
  },
  // Path CONTAINMENT decides which worktree owns a file, gates destructive work
  // (ai-vault/session-delete, worktree-removal-safety, relay-watcher-removal-fence)
  // and authorizes filesystem access, so parity is mandatory and a sentinel is
  // impossible: `boolean` and `string | null` (null = "not contained") are total.
  // The mobile client binds no seam at all, so the pre-ready value is the only
  // value it will ever see. One row per shape whose fold is not length-preserving.
  {
    name: 'cross-platform-path-resolution.isPathInsideOrEqual(POSIX sibling prefix)',
    call: () => isPathInsideOrEqual('/repo/app', '/repo/application/src/index.ts'),
    contract: {
      kind: 'parity',
      why: "a boundary-less prefix match would hand another workspace's file to this worktree, and the same predicate authorizes deletes"
    }
  },
  {
    name: 'cross-platform-path-resolution.normalizeRuntimePathForComparison(NFD macOS path)',
    call: () => normalizeRuntimePathForComparison('/userhome/ada/프로젝트'.normalize('NFD')),
    contract: {
      kind: 'parity',
      why: 'the fallback runs the same JS normalize("NFC") the core\'s generated tables were derived from, so a non-ASCII workspace keys its sessions identically in both states'
    }
  },
  {
    name: 'cross-platform-path-resolution.relativePathInsideRoot(WSL UNC alias)',
    call: () =>
      relativePathInsideRoot(
        '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
        '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\Src'
      ),
    contract: {
      kind: 'parity',
      why: 'callers rejoin this suffix and hit the filesystem with it, and the alias+case fold is not length-preserving — both states must skip whole root SEGMENTS'
    }
  },
  {
    name: 'cross-platform-path-resolution.relativePathInsideRoot(not contained)',
    call: () => relativePathInsideRoot('/repo/app', '/repo/other'),
    contract: {
      kind: 'parity',
      why: 'null is the twin\'s real answer for "outside the root", not a not-ready signal — which is why the shim gates on isOrcaDispatchReady instead of on a null from tryOrcaDispatch'
    }
  },
  {
    name: 'cross-platform-path-resolution.resolveRuntimePath(windows dot segments)',
    call: () => resolveRuntimePath('C:\\Repos\\app\\repo', '..\\worktrees\\feature'),
    contract: {
      kind: 'parity',
      why: 'the result becomes a worktree path on disk, so a pre-ready guess would create or clone into the wrong directory'
    }
  },
  // Terminal-scrollback pruning of PERSISTED session state: parity is mandatory
  // and no sentinel exists. The predicate's two answers are the two halves of
  // the bug (false deletes the only scrollback an SSH pane can cold-restore,
  // true persists megabytes the local daemon already holds), and the prune
  // returns the session itself, so its only spare state would be "never persist
  // this session again". A row per exported function, plus the unhydrated-
  // catalog branch and the multibyte cap that was the last re-port.
  {
    name: 'workspace-session-terminal-buffer-pruning.shouldPreserveTerminalScrollbackBuffers(ssh)',
    call: () =>
      shouldPreserveTerminalScrollbackBuffers('remote-repo::/remote/worktree', [
        { id: 'local-repo', connectionId: null },
        { id: 'remote-repo', connectionId: 'ssh-target-1' }
      ]),
    contract: {
      kind: 'parity',
      why: "TerminalPane's beforeunload capture gate — a pre-ready false drops the SSH pane's buffers on the one write that had them"
    }
  },
  {
    name: 'workspace-session-terminal-buffer-pruning.shouldPreserveTerminalScrollbackBuffers(local host)',
    call: () =>
      shouldPreserveTerminalScrollbackBuffers('host-repo::/worktree', [
        { id: 'host-repo', connectionId: null, executionHostId: 'local' }
      ]),
    contract: {
      kind: 'parity',
      why: "false is the twin's real answer for an explicitly local host, not a not-ready signal"
    }
  },
  {
    name: 'workspace-session-terminal-buffer-pruning.shouldPreserveTerminalScrollbackBuffers(unhydrated catalog)',
    call: () => shouldPreserveTerminalScrollbackBuffers('unknown-repo::/worktree', []),
    contract: {
      kind: 'parity',
      why: 'the fail-safe branch: an unclassifiable worktree keeps its buffers, and a pre-ready false would delete them instead'
    }
  },
  {
    name: 'workspace-session-terminal-buffer-pruning.capTerminalScrollbackSessionBuffer(multibyte over the cap)',
    call: () => capTerminalScrollbackSessionBuffer('é'.repeat(10), 8),
    contract: {
      kind: 'parity',
      why: 'the byte-vs-char cap that was just re-ported: both paths keep 4 accented chars (8 bytes), never 8 chars (16 bytes)'
    }
  },
  {
    name: 'workspace-session-terminal-buffer-pruning.pruneLocalTerminalScrollbackBuffers(mixed local/ssh)',
    call: () =>
      pruneLocalTerminalScrollbackBuffers(
        {
          activeRepoId: 'local-repo',
          activeWorktreeId: null,
          activeTabId: null,
          tabsByWorktree: {
            'local-repo::/local/worktree': [{ id: 'local-tab' }],
            'remote-repo::/remote/worktree': [{ id: 'remote-tab' }]
          },
          terminalLayoutsByTabId: {
            'local-tab': {
              root: null,
              buffersByLeafId: { 'pane:1': 'local-scrollback' },
              scrollbackRefsByLeafId: { 'pane:1': 'v1-local' },
              ptyIdsByLeafId: { 'pane:1': 'local-pty' }
            },
            'remote-tab': {
              root: null,
              buffersByLeafId: { 'pane:1': 'ééééé' },
              ptyIdsByLeafId: { 'pane:1': 'remote-pty' }
            }
          }
          // Cast: the row only needs the two fields the core reads plus one
          // unrelated key, and a whole WorkspaceSessionState would bury them.
        } as unknown as Parameters<typeof pruneLocalTerminalScrollbackBuffers>[0],
        [
          { id: 'local-repo', connectionId: null },
          { id: 'remote-repo', connectionId: 'ssh-target-1' }
        ],
        { bufferByteLimit: 4 }
      ),
    contract: {
      kind: 'parity',
      why: 'this value IS the persisted session: the local tab must lose both buffer maps and the SSH tab must keep a 4-byte tail, identically before and after the core lands'
    }
  },
  // Worktree IDENTITY: parity is mandatory and a sentinel is impossible. Every
  // return type is already total (a string, or `ParsedWorktreeId | null` where
  // null is the twin's real "no `::` here"), the repo id keys reposById /
  // worktreesByRepo, and the parsed path becomes a PTY cwd and a git working
  // directory — both persisted. A row per exported function, plus the branches
  // that carry the folder-workspace suffix.
  {
    name: 'worktree-id-parsing.getRepoIdFromWorktreeId(canonical)',
    call: () => getRepoIdFromWorktreeId('repo-123::/abs/path'),
    contract: {
      kind: 'parity',
      why: 'the fallback is the twin body over the kept separator — a wrong repo id files the worktree under a repo that does not own it'
    }
  },
  {
    name: 'worktree-id-parsing.getRepoIdFromWorktreeId(no separator)',
    call: () => getRepoIdFromWorktreeId('just-a-repo-id'),
    contract: {
      kind: 'parity',
      why: 'a separator-less id IS its own repo id in both states; an empty string here would key the store under ""'
    }
  },
  {
    name: 'worktree-id-parsing.splitWorktreeId(canonical)',
    call: () => splitWorktreeId('repo-123::/abs/path'),
    contract: {
      kind: 'parity',
      why: 'the two slices are rebuilt inline, so the cwd handed to a PTY is identical before and after the wasm lands'
    }
  },
  {
    name: 'worktree-id-parsing.splitWorktreeId(no separator)',
    call: () => splitWorktreeId('just-a-repo-id'),
    contract: {
      kind: 'parity',
      why: 'null is the twin\'s real answer for this input, not a not-ready signal — callers already branch on it as "not a worktree id"'
    }
  },
  {
    name: 'worktree-id-parsing.splitWorktreeIdForFilesystem(folder instance)',
    call: () =>
      splitWorktreeIdForFilesystem('repo::/folder::workspace:123e4567-e89b-12d3-a456-426614174000'),
    contract: {
      kind: 'parity',
      why: 'the fallback re-runs the kept FOLDER_WORKSPACE_INSTANCE_SUFFIX pattern — leaving the uuid on would hand git and the PTY a directory that does not exist'
    }
  },
  {
    name: 'worktree-id-parsing.getWorktreePathBasenameFromId(posix)',
    call: () => getWorktreePathBasenameFromId('repo-123::/abs/path/nightly-checks'),
    contract: {
      kind: 'parity',
      why: 'composed in the shim over the dispatched split, so both states run the same trim/basename code'
    }
  },
  {
    // Pins the composition decision, not just the value: orca_core trims with
    // Rust's char::is_whitespace and the twin trimmed with JS trim, which differ
    // on U+FEFF (JS only) and U+0085 (Rust only). Wiring this straight to
    // `orca_core::worktree_id::get_worktree_path_basename_from_id` turns the row
    // red instead of quietly rewriting a name persistence.ts flushes into
    // automationRuns[].workspaceDisplayName.
    name: 'worktree-id-parsing.getWorktreePathBasenameFromId(BOM in the leaf name)',
    call: () => getWorktreePathBasenameFromId('repo-123::/abs/path/name\ufeff'),
    contract: {
      kind: 'parity',
      why: "the twin's JS trim stays in TS on BOTH paths because the core does not share it"
    }
  },
  // WSL UNC paths: parity is mandatory and no sentinel exists. The distro picks
  // the `wsl -d <distro>` target and the linuxPath becomes a Windows filesystem
  // path, a PTY cwd and a git working directory; both return types are already
  // total (null is the twin's real "not a WSL path", and the predicate is a bare
  // boolean read inside `if`/`&&`), and mobile/preload never bind the seam at
  // all, so a signal would be their permanent answer. A row per exported
  // function, plus both directions of the predicate.
  {
    name: 'wsl-unc-paths.parseWslUncPath(wsl.localhost)',
    call: () => parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'),
    contract: {
      kind: 'parity',
      why: "the fallback re-runs the twin's kept WSL_UNC_PATH_PATTERN — a wrong distro stats the wrong distro root"
    }
  },
  {
    name: 'wsl-unc-paths.parseWslUncPath(ordinary Windows path)',
    call: () => parseWslUncPath('C:\\Users\\jin'),
    contract: {
      kind: 'parity',
      why: "null is the twin's real answer for a non-WSL path, not a not-ready signal — every caller already branches on it"
    }
  },
  {
    // Pins the correction, not just the value: orca_core splits the tail on '/'
    // where the twin's `.` excluded line terminators, so dispatching this class
    // straight through turns a CR-terminated path the twin refused into a live
    // `wsl -d Ubuntu` target. The shim folds it back to the twin's null.
    name: 'wsl-unc-paths.parseWslUncPath(carriage return in the tail)',
    call: () => parseWslUncPath('//wsl.localhost/Ubuntu/repo\r'),
    contract: {
      kind: 'parity',
      why: 'the twin refused a line-terminator tail and so does the shim, in both states'
    }
  },
  {
    name: 'wsl-unc-paths.isWslUncPath(legacy wsl$)',
    call: () => isWslUncPath('\\\\wsl$\\Ubuntu\\root'),
    contract: {
      kind: 'parity',
      why: 'a pre-ready false would route a WSL worktree down the plain-Windows PTY and path-probe branches'
    }
  },
  {
    name: 'wsl-unc-paths.isWslUncPath(POSIX path)',
    call: () => isWslUncPath('/home/jin/repo'),
    contract: {
      kind: 'parity',
      why: 'the rejecting direction: a pre-ready true would hand a Linux path to the UNC branch'
    }
  },
  {
    // Unported (orca_core has no Linux→Windows counterpart), so it stays TS on
    // both paths; the row pins that it never acquires a not-ready value.
    name: 'wsl-unc-paths.toWindowsWslPath(/mnt drvfs)',
    call: () => toWindowsWslPath('/mnt/c/userhome/jin', 'Ubuntu'),
    contract: { kind: 'parity', why: 'one TS body in both states — nothing crosses the seam' }
  },
  {
    name: 'wsl-unc-paths.mapPosixPathToWslWorktreeUncPath(wsl$ worktree)',
    call: () => mapPosixPathToWslWorktreeUncPath('/etc/hosts', '\\\\wsl$\\Debian\\home\\jin'),
    contract: {
      kind: 'parity',
      why: 'composed over the dispatched parse, so the rebased path a file-open route opens is identical in both states'
    }
  },
  {
    name: 'wsl-unc-paths.foldWslUncPathCaseInsensitiveParts(wsl$ + drvfs tail)',
    call: () => foldWslUncPathCaseInsensitiveParts('\\\\wsl$\\Ubuntu\\mnt\\C\\userhome\\Jin'),
    contract: {
      kind: 'parity',
      why: 'this key is equality-compared against other folded paths, so a pre-ready null would silently miss every match'
    }
  }
]

runShimPreReadyContractSuite(CASES)
