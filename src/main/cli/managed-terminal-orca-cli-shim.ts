import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { quoteShell } from './appimage-cli-wrapper'
import { getBundledLauncherPath } from './cli-installer'
import { buildBareOrcaCliScript } from './linux-bare-orca-dispatcher'

const SHIM_DIR_NAME = 'orca-cli-shim'

// Why: rewriting the shim on every PTY spawn is wasted fs work; the target only
// changes with the install itself, so one successful resolve per input is enough.
// Failures are NOT cached so a transient fs error retries on the next spawn.
const resolvedBinDirs = new Map<string, string>()

export type ManagedTerminalOrcaCliShimOptions = {
  userDataPath: string
  /** Test seam — defaults to the running platform. */
  platform?: NodeJS.Platform
  /** Test seam — defaults to the packaged resources root. */
  resourcesPath?: string | null
  /** Test seam — defaults to $APPIMAGE (set only when running from an AppImage). */
  appImagePath?: string | null
}

// Why: every agent-facing surface (skills, dispatch preambles, CLI hints) invokes
// bare `orca`, but no platform resolves it unaided: Linux installs the CLI as
// `orca-ide` so it never shadows GNOME's /usr/bin/orca screen reader
// (stablyai/orca#7904), and macOS/Windows otherwise depend on a /usr/local/bin
// symlink whose install raises an authorization prompt. Prepending this dir to
// managed-PTY PATH makes bare `orca` resolve inside Orca terminals only, with no
// privileged step, leaving the user's own shells untouched.
export function ensureManagedTerminalOrcaCliBinDir(
  options: ManagedTerminalOrcaCliShimOptions
): string | null {
  const platform = options.platform ?? process.platform
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  if (!resourcesPath) {
    return null
  }
  const appImagePath = options.appImagePath ?? process.env.APPIMAGE ?? null

  const cacheKey = JSON.stringify([platform, options.userDataPath, resourcesPath, appImagePath])
  const cached = resolvedBinDirs.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const binDir =
    platform === 'win32'
      ? resolveWindowsLauncherBinDir(resourcesPath)
      : writeUnixShim(platform, options.userDataPath, resourcesPath, appImagePath)
  if (binDir === null) {
    return null
  }
  resolvedBinDirs.set(cacheKey, binDir)
  return binDir
}

// Why: the native launcher finds Orca.exe and the CLI entrypoint RELATIVE TO
// ITSELF (`<resources>/bin/orca.exe` walks up two levels), so a copy, hardlink or
// junction under userData resolves the app beside userData and dies. Its sibling
// orca.cmd is no substitute either: cmd.exe reparses `%*` and can execute or
// truncate embedded newlines, so that shim deliberately REFUSES `orchestration
// send`/`reply` — the very commands this managed PATH exists to enable. PATH
// therefore points at the shipped bin dir, and buildManagedPathExt keeps `.EXE`
// ahead of `.CMD` so bare `orca` picks the native launcher.
function resolveWindowsLauncherBinDir(resourcesPath: string): string | null {
  const launcher = getBundledLauncherPath('win32', resourcesPath)
  return launcher && existsSync(launcher) ? dirname(launcher) : null
}

function writeUnixShim(
  platform: NodeJS.Platform,
  userDataPath: string,
  resourcesPath: string,
  appImagePath: string | null
): string | null {
  const resolved = buildUnixShimScript(platform, resourcesPath, appImagePath)
  if (!resolved) {
    return null
  }

  const shimDir = join(userDataPath, SHIM_DIR_NAME)
  const shimPath = join(shimDir, 'orca')
  try {
    if (readShim(shimPath) !== resolved.script) {
      mkdirSync(shimDir, { recursive: true })
      writeFileSync(shimPath, resolved.script, 'utf8')
    }
    // Why: always re-assert the exec bit — a shim written by an older run (or
    // restored from backup) with mode stripped would fail every agent CLI call.
    chmodSync(shimPath, 0o755)
  } catch {
    return null
  }
  return shimDir
}

function buildUnixShimScript(
  platform: NodeJS.Platform,
  resourcesPath: string,
  appImagePath: string | null
): { script: string; target: string } | null {
  if (platform === 'linux') {
    return buildBareOrcaCliScript(resourcesPath, appImagePath)
  }
  if (platform !== 'darwin') {
    return null
  }

  const launcher = getBundledLauncherPath('darwin', resourcesPath)
  // Why: the bundled launcher derives Orca.app by truncating its OWN path at
  // `.app`, so the shim execs it where it ships; a copy under userData has no
  // bundle to find. Guard existence so we never point at a missing launcher.
  if (!launcher || !existsSync(launcher)) {
    return null
  }
  return {
    script: `#!/usr/bin/env bash\nexec ${quoteShell(launcher)} "$@"\n`,
    target: launcher
  }
}

function readShim(shimPath: string): string | null {
  try {
    return readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
}

const EXE_EXTENSION = '.EXE'
const BATCH_EXTENSIONS = new Set(['.CMD', '.BAT'])

/** Windows command lookup walks PATHEXT in order, so a PATHEXT listing `.CMD`
 *  before `.EXE` resolves bare `orca` to the orchestration-refusing orca.cmd
 *  shipped beside orca.exe. Returns a reordered PATHEXT, or null when the
 *  inherited one already reaches the native launcher first. */
export function buildManagedPathExt(inherited: string | undefined | null): string | null {
  if (!inherited) {
    // Unset: cmd.exe and PowerShell fall back to a built-in .EXE-before-.CMD list.
    return null
  }

  const entries = inherited
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  const exeIndex = entries.findIndex((entry) => entry.toUpperCase() === EXE_EXTENSION)
  const batchIndex = entries.findIndex((entry) => BATCH_EXTENSIONS.has(entry.toUpperCase()))
  if (exeIndex !== -1 && (batchIndex === -1 || exeIndex < batchIndex)) {
    return null
  }

  const exeEntry = exeIndex === -1 ? EXE_EXTENSION : entries[exeIndex]
  const remaining = entries.filter((_, index) => index !== exeIndex)
  const insertAt = batchIndex === -1 ? 0 : batchIndex
  return [...remaining.slice(0, insertAt), exeEntry, ...remaining.slice(insertAt)].join(';')
}

export type ManagedTerminalCliCommandArgs = {
  platform: NodeJS.Platform
  isPackaged: boolean
  isWsl: boolean
  /** The dir this PTY prepends to PATH, or null when none was prepended. */
  managedBinDir: string | null
}

// Why: agent skills otherwise pick the CLI word from a four-branch heuristic
// (dev session? Linux? Orca-managed terminal?); exporting the resolved word on
// every managed PTY collapses that guess to one answer. Null means no word is
// known to resolve here — the skills' own fallback beats a name that exits 127.
export function resolveManagedTerminalCliCommand(
  args: ManagedTerminalCliCommandArgs
): string | null {
  if (args.isWsl) {
    // Why: a WSL pane runs the guest's own registration, which is `orca-ide`; the
    // host-side PATH shim is a Windows path the guest shell never executes.
    return args.isPackaged ? 'orca-ide' : 'orca-dev'
  }
  if (args.managedBinDir === null) {
    // Why: with no managed dir the only candidates are install-time artifacts (the
    // /usr/local/bin symlink, Linux `orca-ide`) that the user may never have
    // installed — and bare `orca` on Linux is the GNOME screen reader.
    return null
  }
  if (args.isPackaged) {
    return 'orca'
  }
  // Why: the dev launcher is written by the user-triggered CLI install, not at
  // startup, so this dir is routinely on PATH while empty.
  const devLauncher = args.platform === 'win32' ? 'orca-dev.cmd' : 'orca-dev'
  return existsSync(join(args.managedBinDir, devLauncher)) ? 'orca-dev' : null
}
