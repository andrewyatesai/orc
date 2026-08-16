// The twin's three scanner-argument suites, moved verbatim onto the shim
// (config/vitest-orca-dispatch-seam.ts binds the seam for every test file, so
// they run against the REAL Rust core), plus the pre-ready rows: every case is
// replayed with the seam unbound and again bound, and the two must agree. That
// comparison is this module's `parity` declaration — the same check
// shim-pre-ready-contract.test.ts makes for renderer shims, made here because
// that file is already 539 counted lines past its max-lines ceiling in the
// working tree and a max-lines disable is forbidden.
import { afterEach, describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { HIDDEN_DIR_BLOCKLIST, HIDDEN_PATH_BLOCKLIST, NON_DOTTED_PRUNE } from './quick-open-filter'
import {
  buildGitLsFilesArgsForQuickOpen,
  buildHiddenDirExcludeGlobs,
  buildRgArgsForQuickOpen,
  type RgArgsOptions
} from './quick-open-listing-arguments'

// The global seam setup already ran initSync on this same wasm instance.
function rebind(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

/** Run `read` with the seam unbound (the pre-ready answer) and again bound. */
function bothStates<T>(read: () => T): { preReady: T; ready: T } {
  setOrcaDispatchBinding(null)
  const preReady = read()
  rebind()
  return { preReady, ready: read() }
}

afterEach(rebind)

describe('buildHiddenDirExcludeGlobs', () => {
  it('includes node_modules plus blocklist as directory-match globs', () => {
    const globs = buildHiddenDirExcludeGlobs()
    expect(globs).toContain('!**/node_modules')
    expect(globs).toContain('!**/.git')
    expect(globs).toContain('!**/.cache')
    expect(globs).toContain('!**/.local/share')
    // Directory-match form (not contents form) — contents form lets rg still
    // descend into the directory.
    expect(globs).not.toContain('!**/node_modules/**')
  })
})

describe('buildRgArgsForQuickOpen', () => {
  it('primary pass includes --files, --hidden, hidden-dir excludes, no --follow', () => {
    const { primary } = buildRgArgsForQuickOpen({
      searchRoot: '/root',
      excludePathPrefixes: [],
      forceSlashSeparator: false
    })
    expect(primary).toContain('--files')
    expect(primary).toContain('--hidden')
    expect(primary).toContain('!**/node_modules')
    expect(primary).not.toContain('--follow')
  })

  it('ignored pass includes --no-ignore-vcs without .env* whitelist globs, no --follow', () => {
    const { ignoredPass } = buildRgArgsForQuickOpen({
      searchRoot: '/root',
      excludePathPrefixes: [],
      forceSlashSeparator: false
    })
    expect(ignoredPass).toContain('--no-ignore-vcs')
    expect(ignoredPass).not.toContain('.env*')
    expect(ignoredPass).not.toContain('**/.env*')
    expect(ignoredPass).not.toContain('--follow')
  })

  it('forceSlashSeparator emits --path-separator /', () => {
    const { primary } = buildRgArgsForQuickOpen({
      searchRoot: '/r',
      excludePathPrefixes: [],
      forceSlashSeparator: true
    })
    const idx = primary.indexOf('--path-separator')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(primary[idx + 1]).toBe('/')
  })

  it('excludePathPrefixes are escaped as directory-match globs', () => {
    const { primary } = buildRgArgsForQuickOpen({
      searchRoot: '/r',
      excludePathPrefixes: ['packages/app', 'feature[1]'],
      forceSlashSeparator: false
    })
    expect(primary).toContain('!packages/app')
    expect(primary).toContain('!packages/app/**')
    // Glob metacharacters in a literal name must be escaped.
    expect(primary).toContain('!feature\\[1\\]')
  })
})

describe('buildGitLsFilesArgsForQuickOpen', () => {
  it('primary pass is --cached --others --exclude-standard', () => {
    const { primary } = buildGitLsFilesArgsForQuickOpen()
    expect(primary).toEqual([
      '-z',
      '-s',
      '--cached',
      '--others',
      '--exclude-standard',
      '--directory',
      '--no-empty-directory'
    ])
  })

  it('ignored pass surfaces ignored files without .env* pathspec whitelist', () => {
    const { ignoredPass } = buildGitLsFilesArgsForQuickOpen()
    expect(ignoredPass).toEqual([
      '-z',
      '-s',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '--no-empty-directory'
    ])
    expect(ignoredPass).not.toContain('.env*')
    expect(ignoredPass).not.toContain(':(glob)**/.env*')
  })

  it('collapses untracked directories in both passes without generated pathspec churn', () => {
    const { primary, ignoredPass } = buildGitLsFilesArgsForQuickOpen()
    expect(primary).toContain('--directory')
    expect(ignoredPass).toContain('--directory')
    expect(ignoredPass).toContain('--no-empty-directory')
    expect([...primary, ...ignoredPass]).not.toContain(':(exclude,glob)**/node_modules/**')
  })

  it('exclude prefixes prepend positive "." pathspec', () => {
    const { primary, ignoredPass } = buildGitLsFilesArgsForQuickOpen(['packages/app'])
    const dashDashIdx = primary.indexOf('--')
    expect(dashDashIdx).toBeGreaterThanOrEqual(0)
    // Positive pathspec must appear before any exclude pathspec.
    expect(primary[dashDashIdx + 1]).toBe('.')
    expect(primary).toContain(':(exclude,glob)packages/app')
    expect(primary).toContain(':(exclude,glob)packages/app/**')
    expect(ignoredPass).toContain(':(exclude,glob)packages/app')
    expect(ignoredPass).toContain(':(exclude,glob)packages/app/**')
  })
})

// ─── PRE-READY: `parity` ×3 ──────────────────────────────────────────

const RG_OPTION_CASES: RgArgsOptions[] = [
  { searchRoot: '.', excludePathPrefixes: [], forceSlashSeparator: false },
  { searchRoot: '.', excludePathPrefixes: [], forceSlashSeparator: true },
  { searchRoot: '/root', excludePathPrefixes: ['packages/app'], forceSlashSeparator: false },
  { searchRoot: 'C:\\repo', excludePathPrefixes: ['feature[1]', 'a*b'], forceSlashSeparator: true },
  { searchRoot: '\\\\server\\share', excludePathPrefixes: ['a/b/c'], forceSlashSeparator: true },
  { searchRoot: '', excludePathPrefixes: [''], forceSlashSeparator: false },
  { searchRoot: '/r é 🚀', excludePathPrefixes: ['dir\nname', '{x,y}'], forceSlashSeparator: false }
]

const PREFIX_CASES: readonly string[][] = [
  [],
  ['packages/app'],
  ['a', 'b/c'],
  ['feature[1]'],
  [''],
  ['a\\b', '🚀/é']
]

describe('pre-ready contract', () => {
  it('buildHiddenDirExcludeGlobs answers the same unbound and bound', () => {
    const { preReady, ready } = bothStates(() => buildHiddenDirExcludeGlobs())
    expect(preReady).toEqual(ready)
  })

  it('buildRgArgsForQuickOpen answers the same unbound and bound', () => {
    for (const opts of RG_OPTION_CASES) {
      const { preReady, ready } = bothStates(() => buildRgArgsForQuickOpen(opts))
      expect(preReady, `searchRoot=${JSON.stringify(opts.searchRoot)}`).toEqual(ready)
    }
  })

  it('buildGitLsFilesArgsForQuickOpen answers the same unbound and bound', () => {
    for (const prefixes of PREFIX_CASES) {
      const { preReady, ready } = bothStates(() => buildGitLsFilesArgsForQuickOpen(prefixes))
      expect(preReady, JSON.stringify(prefixes)).toEqual(ready)
    }
    // The default parameter is its own case: the encoder sends `{}` and Rust
    // must read an absent key as the empty list, not as a no-arg call.
    const { preReady, ready } = bothStates(() => buildGitLsFilesArgsForQuickOpen())
    expect(preReady).toEqual(ready)
  })

  // Why this is not redundant with the row above: the bound path reads Rust's
  // blocklist table and the readdir fallback (quick-open-readdir-walk.ts) reads
  // the TS one, so a name added to only one side would prune in rg and descend
  // in readdir. This is the only check that compares the two tables.
  it('the Rust blocklist table still matches the TS data the readdir walk reads', () => {
    const expected: string[] = []
    for (const name of [NON_DOTTED_PRUNE, ...HIDDEN_DIR_BLOCKLIST]) {
      expected.push('--glob', `!**/${name}`)
    }
    for (const blockedPath of HIDDEN_PATH_BLOCKLIST) {
      expected.push('--glob', `!**/${blockedPath}`)
    }
    expect(buildHiddenDirExcludeGlobs()).toEqual(expected)
  })
})

describe('inputs that must not cross', () => {
  // A nested worktree path can carry an unpaired UTF-16 surrogate out of a
  // Windows directory name. The codec refuses it (not valid UTF-8), and before
  // the fallback existed that DispatchPayloadError escaped through
  // listFilesWithGit and failed the whole Quick Open listing.
  it('answers a lone-surrogate exclude prefix from the fallback instead of throwing', () => {
    const prefixes = ['packages/\ud800app']
    const { preReady, ready } = bothStates(() => buildGitLsFilesArgsForQuickOpen(prefixes))
    expect(ready).toEqual(preReady)
    expect(ready.primary).toContain(':(exclude,glob)packages/\ud800app')
  })

  it('answers a lone-surrogate rg searchRoot from the fallback instead of throwing', () => {
    const opts: RgArgsOptions = {
      searchRoot: '/root/\udc00leaf',
      excludePathPrefixes: [],
      forceSlashSeparator: false
    }
    const { preReady, ready } = bothStates(() => buildRgArgsForQuickOpen(opts))
    expect(ready).toEqual(preReady)
    expect(ready.primary.at(-1)).toBe('/root/\udc00leaf')
  })

  // serde reads forceSlashSeparator with `as_bool`, so a truthy non-boolean
  // answers false where the twin's `?:` emits the flag. Both halves asserted:
  // remove the guard and the first expectation fails.
  it('keeps a truthy non-boolean forceSlashSeparator local, and says why', () => {
    const opts = {
      searchRoot: '.',
      excludePathPrefixes: [],
      forceSlashSeparator: 1
    } as unknown as RgArgsOptions
    expect(buildRgArgsForQuickOpen(opts).primary).toContain('--path-separator')
    const rawCore = JSON.parse(
      orcaDispatch('quick-open-filter', 'buildRgArgsForQuickOpen', JSON.stringify(opts))
    ) as { primary: string[] }
    // The core's `as_bool` reads it as false — on Windows that ships rg output
    // with `\` separators into a filter that only knows `/`.
    expect(rawCore.primary).not.toContain('--path-separator')
  })

  // serde DROPS a non-string prefix; the twin's escapeGlobPath throws on it.
  it('lets a non-string exclude prefix throw the twin TypeError rather than vanish', () => {
    const prefixes = [42] as unknown as string[]
    expect(() => buildGitLsFilesArgsForQuickOpen(prefixes)).toThrow(TypeError)
    expect(() =>
      buildRgArgsForQuickOpen({
        searchRoot: '.',
        excludePathPrefixes: prefixes,
        forceSlashSeparator: false
      })
    ).toThrow(TypeError)
    // The core would have silently listed the nested worktree instead.
    expect(
      JSON.parse(
        orcaDispatch(
          'quick-open-filter',
          'buildGitLsFilesArgsForQuickOpen',
          JSON.stringify({ excludePathPrefixes: prefixes })
        )
      ) as { primary: string[] }
    ).toEqual(buildGitLsFilesArgsForQuickOpen([]))
  })
})
