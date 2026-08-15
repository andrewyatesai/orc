// The wsl-paths twin's tests, moved with the implementation onto the seam shim.
// Every case runs TWICE — with the dispatch seam unbound (the renderer before
// wasm init, mobile, the preload, the Playwright specs) and bound to the wasm
// core (main/cli via napi, the relay via initSync) — because the distro this
// returns picks the `wsl -d <distro>` target and the linuxPath becomes a real
// Windows filesystem path, a PTY cwd and a git working directory.
import { afterEach, describe, expect, it } from 'vitest'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import {
  foldWslUncPathCaseInsensitiveParts,
  isWslUncPath,
  mapPosixPathToWslWorktreeUncPath,
  parseWslUncPath,
  toWindowsWslPath
} from './wsl-unc-paths'
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

describe('wsl path helpers', () => {
  it('parses modern and legacy WSL UNC paths without platform checks', () => {
    bothStates(() => parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'), {
      distro: 'Ubuntu',
      linuxPath: '/home/jin/repo'
    })
    bothStates(() => parseWslUncPath('\\\\wsl$\\Debian\\home\\jin'), {
      distro: 'Debian',
      linuxPath: '/home/jin'
    })
  })

  it('defaults linuxPath to / for a bare distro share', () => {
    bothStates(() => parseWslUncPath('\\\\wsl.localhost\\Ubuntu'), {
      distro: 'Ubuntu',
      linuxPath: '/'
    })
  })

  it('folds the share spelling case-insensitively but preserves distro casing', () => {
    bothStates(() => parseWslUncPath('//WSL.localhost/Arch/etc/fstab'), {
      distro: 'Arch',
      linuxPath: '/etc/fstab'
    })
  })

  it('rejects ordinary Windows and POSIX paths', () => {
    bothStates(() => isWslUncPath('C:\\userhome\\jin\\repo'), false)
    bothStates(() => isWslUncPath('/home/jin/repo'), false)
    bothStates(() => parseWslUncPath('C:\\Users\\jin'), null)
  })

  it('accepts the legacy wsl$ share', () => {
    bothStates(() => isWslUncPath('\\\\wsl$\\Ubuntu\\root'), true)
  })

  it('rejects an empty distro segment', () => {
    bothStates(() => parseWslUncPath('//wsl.localhost//home'), null)
    bothStates(() => parseWslUncPath('//wsl.localhost/'), null)
    bothStates(() => parseWslUncPath('//wsl.localhost'), null)
  })

  it.each([
    ['/home/jin/repo', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'],
    ['/', '\\\\wsl.localhost\\Ubuntu\\'],
    ['/mnt/c/userhome/jin', 'C:\\userhome\\jin'],
    ['/MNT/c/Repo', '\\\\wsl.localhost\\Ubuntu\\MNT\\c\\Repo'],
    ['/mnt/C/Repo', '\\\\wsl.localhost\\Ubuntu\\mnt\\C\\Repo']
  ])('converts %s without folding case-sensitive Linux paths', (linuxPath, expected) => {
    bothStates(() => toWindowsWslPath(linuxPath, 'Ubuntu'), expected)
  })
})

// The one place orca_core::wsl_paths disagrees with the deleted twin: JS `.`
// excludes line terminators, so the twin refused these while the core's
// split_once accepts them. Delete the CORE_ONLY_TAIL_CHARS guard in the shim and
// the bound half of each case returns {distro:'Ubuntu', linuxPath:'/repo\r'}.
describe('a line terminator in the UNC tail', () => {
  it.each([
    ['carriage return', '//wsl.localhost/Ubuntu/repo\r'],
    ['newline', '//wsl.localhost/Ubuntu/ho\nme'],
    ['line separator', '//wsl.localhost/Ubuntu/a\u2028b'],
    ['paragraph separator', '//wsl.localhost/Ubuntu/a\u2029b']
  ])('is not a WSL UNC path in either state (%s)', (_name, path) => {
    bothStates(() => parseWslUncPath(path), null)
    bothStates(() => isWslUncPath(path), false)
  })

  it('is still allowed inside the distro segment, where the twin allowed it', () => {
    bothStates(() => parseWslUncPath('//wsl.localhost/Ubu\ntu/home'), {
      distro: 'Ubu\ntu',
      linuxPath: '/home'
    })
  })
})

// A Windows directory name can hold an unpaired UTF-16 surrogate, so a path
// built from one can too. The codec refuses to encode it (not valid UTF-8), and
// the twin answered without crossing anything, so both states take the fallback.
describe('a lone surrogate in the path', () => {
  it('is parsed by the fallback rather than throwing', () => {
    bothStates(() => parseWslUncPath('//wsl.localhost/Ubuntu/re\ud800po'), {
      distro: 'Ubuntu',
      linuxPath: '/re\ud800po'
    })
    bothStates(() => isWslUncPath('C:\\re\ud800po'), false)
  })
})

describe('foldWslUncPathCaseInsensitiveParts', () => {
  it('folds share spelling, distro casing, and separators but not the Linux tail', () => {
    bothStates(
      () => foldWslUncPathCaseInsensitiveParts('\\\\WSL$\\Ubuntu\\home\\jin\\Repo'),
      '//wsl.localhost/ubuntu/home/jin/Repo'
    )
    bothStates(
      () => foldWslUncPathCaseInsensitiveParts('//wsl.localhost/UBUNTU/home/jin/Repo'),
      '//wsl.localhost/ubuntu/home/jin/Repo'
    )
  })

  it('folds drvfs automount tails but not other /mnt entries', () => {
    bothStates(
      () => foldWslUncPathCaseInsensitiveParts('\\\\wsl$\\Ubuntu\\mnt\\C\\userhome\\Jin'),
      '//wsl.localhost/ubuntu/mnt/c/userhome/jin'
    )
    bothStates(
      () => foldWslUncPathCaseInsensitiveParts('\\\\wsl$\\Ubuntu\\mnt\\wsl\\Data'),
      '//wsl.localhost/ubuntu/mnt/wsl/Data'
    )
  })

  it('does not treat a case-variant /MNT dir as the drvfs automount', () => {
    bothStates(
      () => foldWslUncPathCaseInsensitiveParts('\\\\wsl$\\Ubuntu\\MNT\\c\\Repo'),
      '//wsl.localhost/ubuntu/MNT/c/Repo'
    )
  })

  it('returns null for non-WSL paths', () => {
    bothStates(() => foldWslUncPathCaseInsensitiveParts('C:\\userhome\\jin'), null)
    bothStates(() => foldWslUncPathCaseInsensitiveParts('//server/share/x'), null)
    bothStates(() => foldWslUncPathCaseInsensitiveParts('/home/jin'), null)
  })
})

describe('mapPosixPathToWslWorktreeUncPath', () => {
  it('rebases a POSIX path onto the WSL worktree UNC share', () => {
    bothStates(
      () =>
        mapPosixPathToWslWorktreeUncPath(
          '/home/jin/repo/src/app.ts',
          '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
        ),
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\src\\app.ts'
    )
  })

  it('preserves the legacy wsl$ share spelling of the worktree', () => {
    bothStates(
      () => mapPosixPathToWslWorktreeUncPath('/etc/hosts', '\\\\wsl$\\Debian\\home\\jin'),
      '\\\\wsl$\\Debian\\etc\\hosts'
    )
  })

  it('maps paths outside the worktree, including drvfs mounts', () => {
    bothStates(
      () =>
        mapPosixPathToWslWorktreeUncPath('/mnt/c/logs/out.txt', '\\\\wsl.localhost\\Ubuntu\\repo'),
      '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\logs\\out.txt'
    )
  })

  it('returns null for non-POSIX paths and non-WSL worktrees', () => {
    const wslWorktree = '\\\\wsl.localhost\\Ubuntu\\repo'
    bothStates(() => mapPosixPathToWslWorktreeUncPath('C:\\userhome\\jin\\a.ts', wslWorktree), null)
    bothStates(
      () => mapPosixPathToWslWorktreeUncPath('\\\\wsl$\\Ubuntu\\repo\\a.ts', wslWorktree),
      null
    )
    bothStates(() => mapPosixPathToWslWorktreeUncPath('//server/share/a.ts', wslWorktree), null)
    bothStates(() => mapPosixPathToWslWorktreeUncPath('/home/jin/a.ts', 'C:\\repo'), null)
    bothStates(() => mapPosixPathToWslWorktreeUncPath('/home/jin/a.ts', '/home/jin/repo'), null)
  })
})
