// The setup-runner-command twin's tests, moved with the implementation onto the
// seam shim (they were src/shared/setup-runner-command.test.ts;
// `getSetupRunnerCommandPlatformForPath`'s cases went to
// src/renderer/src/lib/git-wasm/setup-runner-command-platform.test.ts earlier).
//
// Every case runs TWICE — with the dispatch seam unbound (the renderer before
// wasm init, the preload, the Playwright specs) and bound to the wasm core
// (main/cli via napi, the relay via initSync, the renderer after ready) —
// because what these build is TYPED INTO A LIVE SHELL AND RUNS, so a pre-ready
// answer that differs from the ready one is a command that executes wrong for
// the first user who creates a worktree during boot.
import { afterEach, describe, expect, it } from 'vitest'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import {
  buildSetupRunnerCommand,
  isWslUncPath,
  resolveSetupRunnerCommand,
  wslUncToLinuxPath
} from './setup-runner-command-resolution'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

/** Run `call` unbound and bound; assert both equal `expected`. */
function bothStates<T>(call: () => T, expected: T): void {
  setOrcaDispatchBinding(null)
  expect(call()).toEqual(expected)
  bindWasm()
  expect(call()).toEqual(expected)
}

afterEach(() => setOrcaDispatchBinding(null))

describe('buildSetupRunnerCommand', () => {
  it('uses bash for WSL UNC runner scripts regardless of host casing', () => {
    bothStates(
      () =>
        buildSetupRunnerCommand(
          '\\\\WSL.LOCALHOST\\Ubuntu\\home\\jin\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
          'windows'
        ),
      'bash /home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh'
    )
  })

  it('uses bash with Linux paths for forward-slash WSL UNC runner scripts', () => {
    bothStates(
      () =>
        buildSetupRunnerCommand(
          '//wsl.localhost/Ubuntu/home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh',
          'windows'
        ),
      'bash /home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh'
    )
  })

  it('keeps generic forward-slash UNC runner scripts on cmd.exe', () => {
    bothStates(
      () => buildSetupRunnerCommand('//server/share/repo/.git/orca/setup-runner.cmd', 'windows'),
      'cmd.exe /c "//server/share/repo/.git/orca/setup-runner.cmd"'
    )
  })

  it('delivers native Windows runners through POSIX quoting for Git Bash terminals (#6896)', () => {
    bothStates(
      () => buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', 'posix'),
      `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c 'C:\\repo\\.git\\orca\\setup-runner.cmd'`
    )
  })

  it('nu-escapes the .cmd path for Nushell terminals (#8928 PR4)', () => {
    // Why: nu double-quoted strings treat \ as an escape; unescaped C:\… errors when typed into nu.
    bothStates(
      () => buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', 'nushell'),
      'cmd.exe /c "C:\\\\repo\\\\.git\\\\orca\\\\setup-runner.cmd"'
    )
  })

  it('keeps cmd.exe delivery for cmd and PowerShell terminals', () => {
    bothStates(
      () => buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', 'cmd'),
      'cmd.exe /c "C:\\repo\\.git\\orca\\setup-runner.cmd"'
    )
    bothStates(
      () =>
        buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', 'powershell'),
      'cmd.exe /c "C:\\repo\\.git\\orca\\setup-runner.cmd"'
    )
  })

  it('keeps bash delivery for WSL UNC runners regardless of terminal shell family', () => {
    bothStates(
      () =>
        buildSetupRunnerCommand(
          '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\.git\\orca\\setup-runner.sh',
          'windows',
          'posix'
        ),
      'bash /home/jin/repo/.git/orca/setup-runner.sh'
    )
  })

  it('uses bash on posix, single-quoting paths with unsafe characters', () => {
    bothStates(
      () => buildSetupRunnerCommand('/home/me/orca/setup-runner.sh', 'posix'),
      'bash /home/me/orca/setup-runner.sh'
    )
    bothStates(
      () => buildSetupRunnerCommand('/home/me/my repo/setup-runner.sh', 'posix'),
      "bash '/home/me/my repo/setup-runner.sh'"
    )
  })

  it('uses bash for posix-style paths on windows', () => {
    bothStates(
      () => buildSetupRunnerCommand('/mnt/c/orca/setup-runner.sh', 'windows'),
      'bash /mnt/c/orca/setup-runner.sh'
    )
  })
})

describe('resolveSetupRunnerCommand', () => {
  it('reports the forward-slash spelling Git Bash will see', () => {
    // setup-agent-sequencing appends `.<nonce>.done` to this field and both the
    // setup command and the startup gate poll that marker, so it must be the
    // .cmd path as GIT BASH spells it, not as cmd.exe does.
    bothStates(
      () => resolveSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', 'posix'),
      {
        command: `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c 'C:\\repo\\.git\\orca\\setup-runner.cmd'`,
        runnerScriptPathForShell: 'C:/repo/.git/orca/setup-runner.cmd',
        shell: 'posix'
      }
    )
  })

  it('keeps the backslash spelling and the windows shell for nushell', () => {
    bothStates(
      () =>
        resolveSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', 'nushell'),
      {
        command: 'cmd.exe /c "C:\\\\repo\\\\.git\\\\orca\\\\setup-runner.cmd"',
        runnerScriptPathForShell: 'C:\\repo\\.git\\orca\\setup-runner.cmd',
        shell: 'windows'
      }
    )
  })

  it('reports the rewritten linux path for WSL runners, not the UNC one', () => {
    bothStates(
      () =>
        resolveSetupRunnerCommand(
          '\\\\wsl.localhost\\Ubuntu\\home\\jin\\run.sh',
          'windows',
          'nushell'
        ),
      {
        command: 'bash /home/jin/run.sh',
        runnerScriptPathForShell: '/home/jin/run.sh',
        shell: 'posix'
      }
    )
  })

  it('ignores the terminal shell family entirely on posix', () => {
    for (const family of [undefined, 'posix', 'cmd', 'powershell', 'nushell'] as const) {
      bothStates(
        () => resolveSetupRunnerCommand('/home/me/orca/setup-runner.sh', 'posix', family),
        {
          command: 'bash /home/me/orca/setup-runner.sh',
          runnerScriptPathForShell: '/home/me/orca/setup-runner.sh',
          shell: 'posix'
        }
      )
    }
  })
})

describe('the WSL predicates this module owns', () => {
  // NOT wsl-unc-paths': that one requires a non-empty distro and rejects
  // line-terminator tails. Both differences decide bash vs cmd.exe, so the two
  // predicates are kept apart on purpose — these cases pin the difference.
  it('needs only the share prefix, unlike wsl-paths', () => {
    bothStates(() => isWslUncPath('\\\\WSL$\\Ubuntu\\x'), true)
    bothStates(() => isWslUncPath('//wsl.localhost/Ubuntu/x'), true)
    bothStates(() => isWslUncPath('//wsl.localhost/'), true)
    bothStates(() => isWslUncPath('//wsl.localhost'), false)
    bothStates(() => isWslUncPath('///wsl$/Ubuntu/x'), false)
    bothStates(() => isWslUncPath('C:\\Users\\jin\\repo'), false)
    bothStates(() => isWslUncPath('/home/jin/repo'), false)
    // JS `/i` in non-unicode mode folds ASCII only: U+017F never matches `s`.
    bothStates(() => isWslUncPath('//w\u017fl.localhost/x'), false)
  })

  it('falls back to root for every non-match', () => {
    bothStates(() => wslUncToLinuxPath('\\\\wsl$\\Ubuntu\\home\\jin'), '/home/jin')
    bothStates(() => wslUncToLinuxPath('//wsl$/Ubuntu'), '/')
    bothStates(() => wslUncToLinuxPath('//wsl$/Ubuntu/'), '/')
    bothStates(() => wslUncToLinuxPath('//wsl.localhost/'), '/')
    bothStates(() => wslUncToLinuxPath('//wsl$//foo'), '/')
    bothStates(() => wslUncToLinuxPath('C:\\x'), '/')
  })

  it('fails the whole match on a line terminator in the tail, like JS `.` does', () => {
    for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
      bothStates(() => wslUncToLinuxPath(`//wsl$/Ubuntu/a${terminator}b`), '/')
      // …and the command that gets EXECUTED follows it.
      bothStates(
        () => buildSetupRunnerCommand(`//wsl$/Ubuntu/a${terminator}b`, 'windows'),
        'bash /'
      )
    }
    // In the DISTRO it is fine — `[^/]` matches a line terminator.
    bothStates(() => wslUncToLinuxPath('//wsl$/Ub\nuntu/x'), '/x')
  })
})

describe('inputs the shim refuses to dispatch', () => {
  // The guard exists because for these the core does not fail, it answers
  // something ELSE — and the answer is executed. Each case is pinned against the
  // TWIN's behaviour in BOTH seam states; the whole point is that binding the
  // seam must not change them.
  it('answers a non-string runner path exactly as the twin did, not as an empty path', () => {
    // `Value::as_str().unwrap_or("")` would make this `bash ''`.
    bothStates(
      () => buildSetupRunnerCommand(undefined as unknown as string, 'posix'),
      'bash undefined'
    )
    bothStates(() => buildSetupRunnerCommand(null as unknown as string, 'posix'), 'bash null')
    bothStates(() => buildSetupRunnerCommand(42 as unknown as string, 'posix'), 'bash 42')
    bothStates(() => resolveSetupRunnerCommand(7 as unknown as string, 'posix'), {
      command: 'bash 7',
      runnerScriptPathForShell: 7 as unknown as string,
      shell: 'posix'
    })
  })

  it("throws the twin's TypeError for a non-string on the windows branch", () => {
    for (const bind of [() => setOrcaDispatchBinding(null), bindWasm]) {
      bind()
      expect(() => buildSetupRunnerCommand(undefined as unknown as string, 'windows')).toThrow(
        TypeError
      )
      expect(() => isWslUncPath(undefined as unknown as string)).toThrow(TypeError)
      expect(() => wslUncToLinuxPath(null as unknown as string)).toThrow(TypeError)
    }
  })

  it('falls through to the posix branch for an unknown platform, instead of throwing', () => {
    // The core answers `__parity_error__` for this, which decodes as a throw.
    bothStates(
      () => buildSetupRunnerCommand('/home/me/run.sh', 'linux' as unknown as 'posix'),
      'bash /home/me/run.sh'
    )
  })

  it('falls through to the cmd.exe default for an unknown terminal shell family', () => {
    bothStates(
      () => buildSetupRunnerCommand('C:\\repo\\run.cmd', 'windows', 'fish' as unknown as 'posix'),
      'cmd.exe /c "C:\\repo\\run.cmd"'
    )
  })

  it('answers a lone-surrogate path from the fallback rather than throwing', () => {
    // A Windows directory name can hold an unpaired surrogate, so a runner path
    // built from one can too; the codec cannot encode it at all.
    bothStates(
      () => buildSetupRunnerCommand('/home/jin/re\ud800po/run.sh', 'posix'),
      "bash '/home/jin/re\ud800po/run.sh'"
    )
    bothStates(() => isWslUncPath('//wsl$/Ubuntu/re\ud800po'), true)
    bothStates(() => wslUncToLinuxPath('//wsl$/Ubuntu/re\ud800po'), '/re\ud800po')
  })
})
