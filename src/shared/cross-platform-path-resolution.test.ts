// Moved here from cross-platform-path.test.ts when the module was cut over: the
// behaviour these cases describe is now the Rust core's, reached through the
// shim. config/vitest-orca-dispatch-seam.ts binds the seam for every test file,
// so the `describe` below exercises the READY path; the final describe re-runs
// the same inputs unbound and asserts the two states agree, which is the shim's
// `parity` contract stated as a test rather than as a comment.
import { afterEach, describe, expect, it } from 'vitest'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import {
  createNormalizedPathInsideOrEqualMatcher,
  getRuntimePathBasename,
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators,
  relativePathInsideRoot,
  resolveRuntimePath
} from './cross-platform-path-resolution'
import { areLocalWindowsWslPathAliases, isCaseInsensitiveRuntimeRoot } from './cross-platform-path'

const bindSeam = (): void => {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

describe('areLocalWindowsWslPathAliases', () => {
  it('matches UNC aliases and mounted drives without folding the Linux tail', () => {
    // \\wsl$ and \\wsl.localhost front the same 9P share.
    expect(
      areLocalWindowsWslPathAliases(
        '//wsl.localhost/Ubuntu/home/Alice/file.ts',
        '\\\\wsl$\\ubuntu\\home\\Alice\\file.ts'
      )
    ).toBe(true)
    // The case-sensitive Linux tail must not fold (alice !== Alice).
    expect(
      areLocalWindowsWslPathAliases(
        '//wsl.localhost/Ubuntu/home/Alice/file.ts',
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\file.ts'
      )
    ).toBe(false)
    // /mnt/<drive> resolves to the native Windows drive.
    expect(
      areLocalWindowsWslPathAliases(
        '//wsl.localhost/Ubuntu/mnt/c/repo/file.ts',
        'C:\\repo\\file.ts'
      )
    ).toBe(true)
    // Two plain UNC shares are never WSL aliases.
    expect(
      areLocalWindowsWslPathAliases('//server/share/file.ts', '\\\\server\\share\\file.ts')
    ).toBe(false)
  })
})

describe('isCaseInsensitiveRuntimeRoot', () => {
  it('folds Windows drive and UNC roots by syntax, never the client platform', () => {
    expect(isCaseInsensitiveRuntimeRoot('C:\\Users\\dev\\repo')).toBe(true)
    expect(isCaseInsensitiveRuntimeRoot('c:/users/dev/repo')).toBe(true)
    expect(isCaseInsensitiveRuntimeRoot('\\\\Server\\Share\\repo')).toBe(true)
  })

  it('keeps WSL UNC aliases and POSIX/SSH roots case-sensitive', () => {
    // The WSL UNC alias fronts a case-sensitive Linux filesystem.
    expect(isCaseInsensitiveRuntimeRoot('\\\\wsl$\\Ubuntu\\home\\dev\\repo')).toBe(false)
    expect(isCaseInsensitiveRuntimeRoot('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo')).toBe(false)
    // POSIX roots (native Linux, macOS, SSH) never fold, even a home directory.
    expect(isCaseInsensitiveRuntimeRoot('/home/dev/repo')).toBe(false)
    expect(isCaseInsensitiveRuntimeRoot('/srv/home/dev/repo')).toBe(false)
  })
})

describe('cross-platform path containment', () => {
  it('keeps POSIX sibling prefixes outside the root', () => {
    expect(isPathInsideOrEqual('/repo/app', '/repo/app')).toBe(true)
    expect(isPathInsideOrEqual('/repo/app', '/repo/app/src/index.ts')).toBe(true)
    expect(isPathInsideOrEqual('/repo/app', '/repo/application/src/index.ts')).toBe(false)
    expect(relativePathInsideRoot('/repo/app/', '/repo/app/src/index.ts')).toBe('src/index.ts')
  })

  it('keeps literal POSIX backslashes distinct from separators', () => {
    expect(normalizeRuntimePathForComparison('/srv/team\\repo')).toBe('/srv/team\\repo')
    expect(normalizeRuntimePathForComparison('/srv/team/repo')).toBe('/srv/team/repo')
    expect(isPathInsideOrEqual('/srv/team\\repo', '/srv/team/repo/file.ts')).toBe(false)
    expect(relativePathInsideRoot('/srv/repo', '/srv/repo/a\\b.txt')).toBe('a\\b.txt')
  })

  it('handles Windows drive roots and sibling drives case-insensitively', () => {
    expect(isPathInsideOrEqual('C:\\Repo', 'c:\\repo\\src\\index.ts')).toBe(true)
    expect(relativePathInsideRoot('C:\\Repo', 'c:\\repo\\src\\index.ts')).toBe('src/index.ts')
    expect(isPathInsideOrEqual('C:\\Repo', 'D:\\Repo\\src\\index.ts')).toBe(false)
    expect(relativePathInsideRoot('C:\\', 'c:\\repo\\src\\index.ts')).toBe('repo/src/index.ts')
  })

  it('handles UNC roots, trailing slashes, mixed separators, and case', () => {
    expect(isPathInsideOrEqual('\\\\Server\\Share\\Repo\\', '//server/share/repo/src')).toBe(true)
    expect(relativePathInsideRoot('\\\\Server\\Share\\Repo\\', '//server/share/repo/src')).toBe(
      'src'
    )
    expect(isPathInsideOrEqual('\\\\Server\\Share\\Repo', '\\\\server\\share\\repo2')).toBe(false)
  })

  it('treats WSL UNC aliases as the same case-sensitive filesystem', () => {
    expect(
      isPathInsideOrEqual(
        '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
        '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\src'
      )
    ).toBe(true)
    expect(
      relativePathInsideRoot(
        '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
        '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\Src'
      )
    ).toBe('Src')
    expect(
      isPathInsideOrEqual(
        '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
        '\\\\wsl.localhost\\ubuntu\\home\\alice\\repo\\src'
      )
    ).toBe(false)
    expect(
      relativePathInsideRoot(
        '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
        '\\\\wsl.localhost\\ubuntu\\home\\alice\\repo\\src'
      )
    ).toBeNull()
    expect(
      relativePathInsideRoot(
        '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
        '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\line\nbreak'
      )
    ).toBe('line\nbreak')
  })

  it('matches macOS NFD paths against agent-recorded NFC paths', () => {
    // Regression for #10832: macOS file pickers hand Orca decomposed (NFD) paths
    // while Claude Code records cwd and names its project dirs in NFC, so a
    // non-ASCII workspace never matched its own sessions.
    const nfc = '/userhome/ada/내 드라이브/프로젝트'
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc)

    expect(normalizeRuntimePathForComparison(nfd)).toBe(normalizeRuntimePathForComparison(nfc))
    expect(isPathInsideOrEqual(nfd, `${nfc}/src`)).toBe(true)
    expect(isPathInsideOrEqual(nfc, `${nfd}/src`)).toBe(true)

    // WSL UNC keys return before the trailing fold, so they need NFC too.
    expect(
      normalizeRuntimePathForComparison(
        `\\\\wsl$\\Ubuntu\\home\\ada\\${'프로젝트'.normalize('NFD')}`
      )
    ).toBe(normalizeRuntimePathForComparison(`\\\\wsl.localhost\\Ubuntu\\home\\ada\\프로젝트`))
  })

  it('returns a byte-exact suffix when comparison folding changes length', () => {
    // Comparison folding (NFC, case) is not length-preserving, so slicing the raw
    // candidate by the folded root's length would cut mid-character and fabricate
    // a path — callers rejoin this suffix and hit the filesystem with it.
    const nfc = '/userhome/ada/프로젝트'
    const nfd = nfc.normalize('NFD')
    for (const root of [nfc, nfd]) {
      for (const candidate of [nfc, nfd]) {
        expect(relativePathInsideRoot(root, `${candidate}/src/index.ts`)).toBe('src/index.ts')
      }
    }

    // Pre-existing over-slice: toLowerCase expands U+0130 to two UTF-16 units.
    expect(relativePathInsideRoot('C:\\İş', 'C:\\İş\\src\\a.ts')).toBe('src/a.ts')

    // U+212A KELVIN SIGN folds to 'K', so the root and candidate must agree on
    // Windows-ness or their segment counts desync and the suffix comes back ''.
    expect(relativePathInsideRoot('\u212A:/a\\b', '\u212A:/a\\b/c')).toBe(
      relativePathInsideRoot('K:/a\\b', 'K:/a\\b/c')
    )

    // Astral characters must not be cut mid-surrogate-pair.
    expect(relativePathInsideRoot('/repo/🚀app', '/repo/🚀app/src/🎉file.ts')).toBe('src/🎉file.ts')

    // A UNC-shaped candidate under POSIX root '/' used to yield a leading slash,
    // which is not a relative path.
    expect(relativePathInsideRoot('/', '//server/share/x')).toBe('server/share/x')

    // WSL suffixes must stay decomposed: they name files on a Linux filesystem,
    // where NFD and NFC are distinct entries.
    const decomposed = '프로젝트'.normalize('NFD')
    expect(
      relativePathInsideRoot(
        '\\\\wsl$\\Ubuntu\\home\\ada\\repo',
        `\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo\\${decomposed}\\a.ts`
      )
    ).toBe(`${decomposed}/a.ts`)
  })

  it('resolves POSIX relative paths without using the process cwd', () => {
    expect(resolveRuntimePath('/repos/app/repo', '../worktrees/feature')).toBe(
      '/repos/app/worktrees/feature'
    )
    expect(resolveRuntimePath('/repos/app/repo', '/custom/worktrees')).toBe('/custom/worktrees')
    expect(isRuntimePathAbsolute('../worktrees')).toBe(false)
  })

  it('resolves Windows relative paths with Windows semantics', () => {
    expect(resolveRuntimePath('C:\\Repos\\app\\repo', '..\\worktrees\\feature')).toBe(
      'C:/Repos/app/worktrees/feature'
    )
    expect(resolveRuntimePath('C:\\Repos\\app\\repo', 'D:\\worktrees')).toBe('D:/worktrees')
    expect(isRuntimePathAbsolute('/remote/worktrees', 'windows')).toBe(true)
  })
})

// Every probe the pre-ready sweep cares about, as one comparable snapshot.
function probeAll(): string {
  const roots = [
    '/repo/app',
    '/srv/team\\repo',
    'C:\\Repo',
    'C:\\',
    '\\\\Server\\Share\\Repo\\',
    '\\\\wsl$\\Ubuntu\\home\\Alice\\repo',
    '/userhome/ada/프로젝트'.normalize('NFD'),
    '\u212A:/a\\b',
    '/'
  ]
  const candidates = [
    '/repo/app/src/index.ts',
    '/repo/application/src/index.ts',
    '/srv/team/repo/file.ts',
    'c:\\repo\\src\\index.ts',
    '//server/share/repo/src',
    '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\Src',
    '/userhome/ada/프로젝트/src/🎉file.ts',
    '\u212A:/a\\b/c',
    '//server/share/x',
    '../worktrees/feature',
    'D:\\worktrees'
  ]
  const answers: unknown[] = []
  for (const value of [...roots, ...candidates]) {
    answers.push(
      normalizeRuntimePathSeparators(value),
      normalizeRuntimePathForComparison(value),
      getRuntimePathBasename(value),
      isRuntimePathAbsolute(value),
      isRuntimePathAbsolute(value, 'posix'),
      isRuntimePathAbsolute(value, 'windows')
    )
  }
  for (const rootPath of roots) {
    const matcher = createNormalizedPathInsideOrEqualMatcher(rootPath)
    for (const candidatePath of candidates) {
      answers.push(
        isPathInsideOrEqual(rootPath, candidatePath),
        relativePathInsideRoot(rootPath, candidatePath),
        resolveRuntimePath(rootPath, candidatePath),
        matcher(normalizeRuntimePathForComparison(candidatePath))
      )
    }
  }
  return JSON.stringify(answers)
}

describe('pre-ready parity (orca-dispatch seam)', () => {
  afterEach(bindSeam)

  it('answers identically unbound and bound', () => {
    // Unbound is not a hypothetical: the Expo mobile client bundles no napi and
    // no wasm, so its four agent-history importers only ever see this state.
    setOrcaDispatchBinding(null)
    const unbound = probeAll()
    bindSeam()
    expect(probeAll()).toBe(unbound)
  })

  it('agrees with the matcher fan-out on an already-normalized candidate', () => {
    bindSeam()
    const matcher = createNormalizedPathInsideOrEqualMatcher('\\\\wsl$\\Ubuntu\\home\\Alice\\repo')
    // The fold is not idempotent for WSL UNC, so the matcher must be fed the
    // normalized candidate — and must then agree with the dispatched predicate.
    for (const candidatePath of [
      '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\src',
      '\\\\wsl.localhost\\ubuntu\\home\\alice\\repo\\src',
      '\\\\wsl$\\Ubuntu\\home\\Alice\\repo'
    ]) {
      expect(matcher(normalizeRuntimePathForComparison(candidatePath))).toBe(
        isPathInsideOrEqual('\\\\wsl$\\Ubuntu\\home\\Alice\\repo', candidatePath)
      )
    }
  })

  it('answers a codec-refused path instead of throwing', () => {
    // A Windows directory name can hold an unpaired UTF-16 surrogate, which
    // JSON.stringify emits as `"\ud800"` — valid JSON text that is not valid
    // UTF-8, so the codec refuses the payload. The twin answered without
    // crossing, and so does this.
    bindSeam()
    expect(relativePathInsideRoot('C:\\repo', 'C:\\repo\\bad\ud800name')).toBe('bad\ud800name')
    expect(isPathInsideOrEqual('C:\\repo', 'C:\\other\ud800')).toBe(false)
    expect(getRuntimePathBasename('/a/b\ud800')).toBe('b\ud800')
  })
})
