import { execFile } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { quoteShell } from './appimage-cli-wrapper'

vi.mock('electron', () => ({
  app: { isPackaged: true }
}))

import {
  buildManagedPathExt,
  ensureManagedTerminalOrcaCliBinDir,
  resolveManagedTerminalCliCommand
} from './managed-terminal-orca-cli-shim'

const execFileAsync = promisify(execFile)
const itRunsUnixShell = process.platform === 'win32' ? it.skip : it
const created: string[] = []
const darwinLauncherAsset = new URL('../../../resources/darwin/bin/orca', import.meta.url)
// The CLI the packaged app actually ships (asarUnpack `out/cli/**`). `pnpm test`
// does not build it, so the real-CLI cases skip on an unbuilt checkout; the argv
// cases below cover the same exec chain without it.
const builtCliDir = new URL('../../../out/cli', import.meta.url)
const itRunsBuiltCli =
  process.platform === 'win32' || !existsSync(new URL('index.js', `${builtCliDir}/`)) ? it.skip : it
const windowsLauncherSource = new URL(
  '../../../native/windows-cli-launcher/OrcaCliLauncher.cs',
  import.meta.url
)
const builderConfig = createRequire(import.meta.url)(
  '../../../config/electron-builder.config.cjs'
) as {
  mac?: { extraResources?: { from?: string; to?: string }[] }
  win?: { executableName?: string; extraResources?: { from?: string; to?: string }[] }
}

async function makeFixture(
  launcherName: 'orca-ide' | 'orca' | 'orca.exe'
): Promise<{ userDataPath: string; resourcesPath: string; launcherPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-'))
  created.push(root)
  const resourcesPath = join(root, 'resources')
  // The bundled launcher must exist for the shim to resolve.
  mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
  const launcherPath = join(resourcesPath, 'bin', launcherName)
  writeFileSync(launcherPath, '#!/usr/bin/env bash\n', 'utf8')
  return { userDataPath: join(root, 'user-data'), resourcesPath, launcherPath }
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ensureManagedTerminalOrcaCliBinDir', () => {
  it('writes an executable bare-orca shim that execs the bundled orca-ide launcher on Linux', async () => {
    const { userDataPath, resourcesPath, launcherPath } = await makeFixture('orca-ide')

    const shimDir = ensureManagedTerminalOrcaCliBinDir({
      platform: 'linux',
      userDataPath,
      resourcesPath,
      appImagePath: null
    })

    expect(shimDir).toBe(join(userDataPath, 'orca-cli-shim'))
    const content = readFileSync(join(shimDir!, 'orca'), 'utf8')
    // Single-quoted so a resources path with shell metacharacters can't break out.
    expect(content).toContain(`exec '${launcherPath}' "$@"`)
    const mode = statSync(join(shimDir!, 'orca')).mode & 0o777
    expect(mode & 0o111).not.toBe(0)
  })

  it('writes an executable bare-orca shim that execs the bundled launcher at its bundle path on macOS', async () => {
    const { userDataPath, resourcesPath, launcherPath } = await makeFixture('orca')

    const shimDir = ensureManagedTerminalOrcaCliBinDir({
      platform: 'darwin',
      userDataPath,
      resourcesPath,
      appImagePath: null
    })

    expect(shimDir).toBe(join(userDataPath, 'orca-cli-shim'))
    const shimPath = join(shimDir!, 'orca')
    // Why: the launcher derives Orca.app from its own path, so the shim must exec
    // it where it ships instead of copying the bytes into userData.
    expect(readFileSync(shimPath, 'utf8')).toContain(`exec '${launcherPath}' "$@"`)
    expect(readFileSync(shimPath, 'utf8')).not.toContain('ELECTRON_RUN_AS_NODE')
    expect(statSync(shimPath).mode & 0o111).not.toBe(0)
  })

  it('points Windows PATH at the shipped native launcher, never at a userData copy or orca.cmd', async () => {
    const { userDataPath, resourcesPath, launcherPath } = await makeFixture('orca.exe')
    writeFileSync(join(resourcesPath, 'bin', 'orca.cmd'), '@echo off\n', 'utf8')

    const binDir = ensureManagedTerminalOrcaCliBinDir({
      platform: 'win32',
      userDataPath,
      resourcesPath,
      appImagePath: null
    })

    // Why: orca.exe resolves Orca.exe and the CLI entry two levels above itself,
    // so any copy under userData looks for the app beside userData and fails.
    expect(binDir).toBe(join(resourcesPath, 'bin'))
    expect(join(binDir!, 'orca.exe')).toBe(launcherPath)
    expect(() => statSync(join(userDataPath, 'orca-cli-shim'))).toThrow()
  })

  it('returns null on Windows when the native launcher is missing rather than falling back to orca.cmd', async () => {
    const { userDataPath, resourcesPath } = await makeFixture('orca')
    writeFileSync(join(resourcesPath, 'bin', 'orca.cmd'), '@echo off\n', 'utf8')

    expect(
      ensureManagedTerminalOrcaCliBinDir({
        platform: 'win32',
        userDataPath,
        resourcesPath,
        appImagePath: null
      })
    ).toBeNull()
  })

  it('memoizes per resolved input and re-asserts the exec bit for a stale shim', async () => {
    const { userDataPath, resourcesPath } = await makeFixture('orca-ide')
    const options = { platform: 'linux', userDataPath, resourcesPath, appImagePath: null } as const

    const first = ensureManagedTerminalOrcaCliBinDir(options)
    expect(first).not.toBeNull()
    chmodSync(join(first!, 'orca'), 0o644)
    expect(ensureManagedTerminalOrcaCliBinDir(options)).toBe(first)

    // A distinct userData path is not memoized, so ensure runs again and heals
    // the exec bit lost above only when it actually processes that path.
    const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-2-'))
    created.push(root)
    const otherUserData = join(root, 'user-data')
    mkdirSync(join(otherUserData, 'orca-cli-shim'), { recursive: true })
    writeFileSync(join(otherUserData, 'orca-cli-shim', 'orca'), 'stale contents', 'utf8')
    chmodSync(join(otherUserData, 'orca-cli-shim', 'orca'), 0o644)

    const healed = ensureManagedTerminalOrcaCliBinDir({
      platform: 'linux',
      userDataPath: otherUserData,
      resourcesPath,
      appImagePath: null
    })
    expect(healed).not.toBeNull()
    const healedPath = join(healed!, 'orca')
    expect(readFileSync(healedPath, 'utf8')).toContain('orca-ide')
    expect(statSync(healedPath).mode & 0o111).not.toBe(0)
  })

  it('execs the stable AppImage (not the ephemeral mount) when running from an AppImage', async () => {
    const { userDataPath, resourcesPath } = await makeFixture('orca-ide')
    const appImagePath = join(userDataPath, 'Applications', 'Orca.AppImage')

    const shimDir = ensureManagedTerminalOrcaCliBinDir({
      platform: 'linux',
      userDataPath,
      resourcesPath,
      appImagePath
    })

    const content = readFileSync(join(shimDir!, 'orca'), 'utf8')
    expect(content).toContain(appImagePath)
    expect(content).not.toContain(resourcesPath)
  })

  it('returns null (and does not memoize) when the bundled launcher is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-missing-'))
    created.push(root)
    const userDataPath = join(root, 'user-data')
    const resourcesPath = join(root, 'resources')

    const missing = ensureManagedTerminalOrcaCliBinDir({
      platform: 'linux',
      userDataPath,
      resourcesPath,
      appImagePath: null
    })
    expect(missing).toBeNull()

    // Once the launcher exists (e.g. later probe with real resources), the same
    // userData path succeeds — proving failures are not cached.
    mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
    writeFileSync(join(resourcesPath, 'bin', 'orca-ide'), '#!/usr/bin/env bash\n', 'utf8')
    const recovered = ensureManagedTerminalOrcaCliBinDir({
      platform: 'linux',
      userDataPath,
      resourcesPath,
      appImagePath: null
    })
    expect(recovered).toBe(join(userDataPath, 'orca-cli-shim'))
  })
})

describe('packaging binds the launcher to where the shim points', () => {
  it('ships orca.exe (not only orca.cmd) in the Windows dir the shim prepends', () => {
    const targets = (builderConfig.win?.extraResources ?? []).map((resource) => resource.to)
    // Why: the shim prepends `<resources>/bin` on the strength of orca.exe being
    // there; if packaging ever drops it, PATH would resolve the orchestration-
    // refusing orca.cmd instead.
    expect(targets).toContain('bin/orca.exe')
    expect(targets).toContain('bin/orca.cmd')
  })

  it('ships the macOS launcher at the bundle path the shim execs', () => {
    expect((builderConfig.mac?.extraResources ?? []).map((resource) => resource.to)).toContain(
      'bin/orca'
    )
  })
})

// Why: no Windows shell exists on this host, so these apply each shell's DOCUMENTED
// lookup rule to the directory contents and PATHEXT we actually emit. cmd.exe and
// PowerShell walk PATHEXT in order; MSYS (Git Bash) tries the literal name and then
// appends only `.exe`, so it never reaches a `.cmd`. Real-shell verification is owed.
const SHELL_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
// Every name the packaged Windows bin dir puts on the managed PATH.
const shippedWindowsBinNames = (builderConfig.win?.extraResources ?? [])
  .map((resource) => resource.to ?? '')
  .filter((target) => target.startsWith('bin/'))
  .map((target) => target.slice('bin/'.length))

function resolveByPathExt(names: string[], pathExt: string): string | undefined {
  for (const extension of pathExt.split(';')) {
    const hit = names.find((name) => name.toUpperCase() === `ORCA${extension.toUpperCase()}`)
    if (hit) {
      return hit
    }
  }
  return undefined
}

describe('Windows shell resolution contract (rule-checked, no Windows shell executed)', () => {
  it('resolves orca.exe in cmd.exe and PowerShell under every PATHEXT we emit', () => {
    for (const inherited of [SHELL_DEFAULT_PATHEXT, '.COM;.BAT;.CMD;.EXE', '.CMD', '.PY', '']) {
      const emitted = buildManagedPathExt(inherited) ?? inherited
      const effective = emitted.length > 0 ? emitted : SHELL_DEFAULT_PATHEXT
      expect(resolveByPathExt(shippedWindowsBinNames, effective)).toBe('orca.exe')
    }
  })

  it('resolves orca.exe in Git Bash, which never appends .cmd', () => {
    const gitBashHit =
      shippedWindowsBinNames.find((name) => name === 'orca') ??
      shippedWindowsBinNames.find((name) => name.toLowerCase() === 'orca.exe')
    expect(gitBashHit).toBe('orca.exe')
  })

  it('keeps the Windows executable named as orca.exe hardcodes it', () => {
    // Why: orca.exe execs `<app>/Orca.exe` by literal name. Unlike macOS — where
    // the executable follows productName and a fork bundle broke the launcher —
    // Windows pins executableName, so the two must stay in step.
    expect(builderConfig.win?.executableName).toBe('Orca')
    expect(readFileSync(fileURLToPath(windowsLauncherSource), 'utf8')).toContain(
      'Path.Combine(appDirectory, "Orca.exe")'
    )
  })
})

/** A macOS bundle laid out exactly as electron-builder packs one: the executable
 *  under Contents/MacOS is named after productName, NOT hardcoded to `Orca`.
 *  `cliEntry` becomes Contents/Resources/app.asar.unpacked/out/cli/index.js. */
async function makeDarwinBundle(
  productName: string,
  cliEntry: { source: URL } | { script: string }
): Promise<{ resourcesPath: string; electronPath: string; cliPath: string; shimDir: string }> {
  // realpath: the launcher resolves its bundle with `cd -P`, which reports
  // /private/var for macOS's /var symlink and would break path equality.
  // Spaces in the prefix: /Applications paths have them, and the shim quotes.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'orca darwin cli shim ')))
  created.push(root)
  const appDir = join(root, `${productName}.app`)
  const resourcesPath = join(appDir, 'Contents', 'Resources')
  const cliDir = join(resourcesPath, 'app.asar.unpacked', 'out', 'cli')
  const electronPath = join(appDir, 'Contents', 'MacOS', productName)

  mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
  mkdirSync(join(appDir, 'Contents', 'MacOS'), { recursive: true })
  if ('source' in cliEntry) {
    // Symlink the whole dir so the entry's own `require` siblings resolve.
    mkdirSync(dirname(cliDir), { recursive: true })
    symlinkSync(fileURLToPath(cliEntry.source), cliDir)
  } else {
    mkdirSync(cliDir, { recursive: true })
    writeFileSync(join(cliDir, 'index.js'), cliEntry.script, 'utf8')
  }
  // The real shipped launcher, so this exercises its own bundle resolution.
  copyFileSync(darwinLauncherAsset, join(resourcesPath, 'bin', 'orca'))
  chmodSync(join(resourcesPath, 'bin', 'orca'), 0o755)
  // Why: ELECTRON_RUN_AS_NODE is what makes an Electron binary behave as node, so
  // the stand-in refuses to run without it instead of silently passing.
  writeFileSync(
    electronPath,
    `#!/usr/bin/env bash
if [ "\${ELECTRON_RUN_AS_NODE-}" != "1" ]; then
	echo "ELECTRON_RUN_AS_NODE not set; would have opened the GUI" >&2
	exit 1
fi
exec ${quoteShell(process.execPath)} "$@"
`,
    { encoding: 'utf8', mode: 0o755 }
  )

  const shimDir = ensureManagedTerminalOrcaCliBinDir({
    platform: 'darwin',
    userDataPath: join(root, 'user-data'),
    resourcesPath,
    appImagePath: null
  })
  expect(shimDir).not.toBeNull()
  return { resourcesPath, electronPath, cliPath: join(cliDir, 'index.js'), shimDir: shimDir! }
}

function runThroughShim(shimDir: string, command: string, env: Record<string, string> = {}) {
  return execFileAsync('/bin/sh', ['-c', command], {
    env: { PATH: [shimDir, '/usr/bin', '/bin'].join(delimiter), ...env }
  })
}

describe('managed-PTY PATH resolution (executed)', () => {
  // Why: the bug this covers was a launcher that hardcoded Contents/MacOS/Orca —
  // fine for `Orca.app`, dead for every fork bundle. Both names must run.
  for (const productName of ['Orca', 'Orca ALab Edition']) {
    itRunsBuiltCli(
      `runs the real Orca CLI through the macOS shim in ${productName}.app`,
      async () => {
        const { shimDir, cliPath } = await makeDarwinBundle(productName, { source: builtCliDir })
        expect(existsSync(cliPath)).toBe(true)

        const result = await runThroughShim(shimDir, 'orca --help')

        // Real CLI output, not an echo of argv: the shim reached the built entry.
        expect(result.stdout).toContain('Usage: orca <command> [options]')
      }
    )

    itRunsUnixShell(
      `forwards argv through the macOS shim in ${productName}.app, newlines intact`,
      async () => {
        const { shimDir, electronPath, cliPath } = await makeDarwinBundle(productName, {
          script: `for (const arg of process.argv.slice(2)) console.log(\`arg=[\${arg}]\`)
console.log(\`entry=\${process.argv[1]}\`)
console.log(\`electron=\${process.env.ORCA_TEST_ELECTRON ?? ''}\`)
`
        })

        const body = 'first line\nsecond line'
        const result = await runThroughShim(
          shimDir,
          'orca orchestration send --body "$ORCA_TEST_BODY"',
          { ORCA_TEST_BODY: body, ORCA_TEST_ELECTRON: electronPath }
        )

        expect(result.stdout).toContain(`entry=${cliPath}`)
        expect(result.stdout).toContain(`electron=${electronPath}`)
        expect(result.stdout).toContain('arg=[orchestration]')
        expect(result.stdout).toContain('arg=[send]')
        expect(result.stdout).toContain(`arg=[${body}]`)
      }
    )
  }

  itRunsUnixShell('fails loudly when the bundle holds no Orca executable', async () => {
    const { shimDir, electronPath } = await makeDarwinBundle('Orca ALab Edition', { script: '' })
    rmSync(electronPath)

    await expect(runThroughShim(shimDir, 'orca --help')).rejects.toThrow(
      /Unable to locate the Orca executable/
    )
  })

  itRunsUnixShell('resolves bare `orca` through the Linux shim with argv intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-linux-cli-shim-'))
    created.push(root)
    const resourcesPath = join(root, 'resources')
    const launcherPath = join(resourcesPath, 'bin', 'orca-ide')
    mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
    writeFileSync(
      launcherPath,
      `#!/usr/bin/env bash
printf 'launcher=%s\\n' "$0"
for arg in "$@"; do printf 'arg=[%s]\\n' "$arg"; done
`,
      { encoding: 'utf8', mode: 0o755 }
    )

    const shimDir = ensureManagedTerminalOrcaCliBinDir({
      platform: 'linux',
      userDataPath: join(root, 'user-data'),
      resourcesPath,
      appImagePath: null
    })

    const body = 'first line\nsecond line'
    const result = await execFileAsync(
      '/bin/sh',
      ['-c', 'orca orchestration send --body "$ORCA_TEST_BODY"'],
      { env: { PATH: [shimDir, '/usr/bin', '/bin'].join(delimiter), ORCA_TEST_BODY: body } }
    )

    expect(result.stdout).toContain(`launcher=${launcherPath}`)
    expect(result.stdout).toContain('arg=[orchestration]')
    expect(result.stdout).toContain(`arg=[${body}]`)
  })
})

describe('buildManagedPathExt', () => {
  it('moves .EXE ahead of .CMD and .BAT so bare `orca` cannot hit orca.cmd', () => {
    expect(buildManagedPathExt('.COM;.BAT;.CMD;.EXE')).toBe('.COM;.EXE;.BAT;.CMD')
    expect(buildManagedPathExt('.CMD;.exe')).toBe('.exe;.CMD')
  })

  it('adds .EXE when a customized PATHEXT omits it entirely', () => {
    expect(buildManagedPathExt('.CMD;.PY')).toBe('.EXE;.CMD;.PY')
    expect(buildManagedPathExt('.PY')).toBe('.EXE;.PY')
  })

  it('leaves an already-safe or absent PATHEXT alone', () => {
    expect(buildManagedPathExt('.COM;.EXE;.BAT;.CMD')).toBeNull()
    expect(buildManagedPathExt('.EXE')).toBeNull()
    expect(buildManagedPathExt(undefined)).toBeNull()
    expect(buildManagedPathExt('')).toBeNull()
  })
})

describe('resolveManagedTerminalCliCommand', () => {
  it('answers bare `orca` on every packaged platform that got a managed bin dir', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(
        resolveManagedTerminalCliCommand({
          platform,
          isPackaged: true,
          isWsl: false,
          managedBinDir: '/managed/bin'
        })
      ).toBe('orca')
    }
  })

  it('answers nothing when no managed bin dir was prepended', () => {
    // Why: the remaining candidates are install-time artifacts the user may never
    // have installed; naming one exports a word the PTY's PATH cannot answer, and
    // skills prefer ORCA_CLI_COMMAND over their own (correct) fallback.
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(
        resolveManagedTerminalCliCommand({
          platform,
          isPackaged: true,
          isWsl: false,
          managedBinDir: null
        })
      ).toBeNull()
    }
  })

  itRunsUnixShell(
    'names the dev CLI only once its launcher exists in the dev bin dir',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-dev-cli-bin-'))
      created.push(root)
      const args = {
        platform: 'darwin',
        isPackaged: false,
        isWsl: false,
        managedBinDir: root
      } as const

      // Why: the dev launcher is written by the user-triggered CLI install, so this
      // dir is routinely on PATH while still empty.
      expect(resolveManagedTerminalCliCommand(args)).toBeNull()
      writeFileSync(join(root, 'orca-dev'), '#!/usr/bin/env bash\n', {
        encoding: 'utf8',
        mode: 0o755
      })
      expect(resolveManagedTerminalCliCommand(args)).toBe('orca-dev')
    }
  )

  it('looks for the .cmd dev launcher on Windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-dev-cli-bin-win-'))
    created.push(root)
    const args = {
      platform: 'win32',
      isPackaged: false,
      isWsl: false,
      managedBinDir: root
    } as const

    writeFileSync(join(root, 'orca-dev'), '', 'utf8')
    expect(resolveManagedTerminalCliCommand(args)).toBeNull()
    writeFileSync(join(root, 'orca-dev.cmd'), '@echo off\n', 'utf8')
    expect(resolveManagedTerminalCliCommand(args)).toBe('orca-dev')
  })

  it('keeps the guest registration name for WSL panes, which ignore the host bin dir', () => {
    expect(
      resolveManagedTerminalCliCommand({
        platform: 'win32',
        isPackaged: true,
        isWsl: true,
        managedBinDir: null
      })
    ).toBe('orca-ide')
    expect(
      resolveManagedTerminalCliCommand({
        platform: 'win32',
        isPackaged: false,
        isWsl: true,
        managedBinDir: null
      })
    ).toBe('orca-dev')
  })
})
