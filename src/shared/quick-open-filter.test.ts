// The three scanner-argument suites moved to quick-open-listing-arguments.test.ts
// with the bodies they cover. What is left is the four functions that stay TS.
import { describe, expect, it } from 'vitest'
import { requireOrcaDispatch } from './orca-dispatch-seam'
import {
  buildExcludePathPrefixes,
  HIDDEN_DIR_BLOCKLIST,
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath,
  type RgOutputMode
} from './quick-open-filter'

/** The real shipped core (config/vitest-orca-dispatch-seam.ts binds the seam). */
function core(fn: string, input: unknown): unknown {
  return requireOrcaDispatch('quick-open-filter', fn, input)
}

describe('shouldIncludeQuickOpenPath', () => {
  it('includes normal source paths', () => {
    expect(shouldIncludeQuickOpenPath('src/index.ts')).toBe(true)
    expect(shouldIncludeQuickOpenPath('.github/workflows/ci.yml')).toBe(true)
    expect(shouldIncludeQuickOpenPath('.env')).toBe(true)
  })

  it('excludes node_modules and blocklisted dirs at any depth', () => {
    expect(shouldIncludeQuickOpenPath('node_modules/a/b.js')).toBe(false)
    expect(shouldIncludeQuickOpenPath('packages/x/node_modules/a.js')).toBe(false)
    expect(shouldIncludeQuickOpenPath('.git/config')).toBe(false)
    expect(shouldIncludeQuickOpenPath('foo/.cache/bar')).toBe(false)
  })

  // Why hidden: home-dir cache/state dirs that caused the original SSH bug.
  // Test name explains why each is filtered.
  it('hides generated npm cache dir from Quick Open', () => {
    expect(shouldIncludeQuickOpenPath('.npm/pkg/index.js')).toBe(false)
  })
  it('hides npm-global install state dir from Quick Open', () => {
    expect(shouldIncludeQuickOpenPath('.npm-global/bin/foo')).toBe(false)
  })
  it('hides GNOME virtual FS runtime mount from Quick Open', () => {
    expect(shouldIncludeQuickOpenPath('.gvfs/mount/file')).toBe(false)
  })
  it('hides local share runtime state without hiding all .local files', () => {
    expect(shouldIncludeQuickOpenPath('.local/share/app/state.db')).toBe(false)
    expect(shouldIncludeQuickOpenPath('nested/.local/share/app/state.db')).toBe(false)
    expect(shouldIncludeQuickOpenPath('.local/bin/tool')).toBe(true)
  })

  it('does NOT blocklist user-authored dirs like .config, .ssh, .github', () => {
    expect(HIDDEN_DIR_BLOCKLIST.has('.config')).toBe(false)
    expect(HIDDEN_DIR_BLOCKLIST.has('.ssh')).toBe(false)
    expect(HIDDEN_DIR_BLOCKLIST.has('.github')).toBe(false)
    expect(HIDDEN_DIR_BLOCKLIST.has('.devcontainer')).toBe(false)
    expect(HIDDEN_DIR_BLOCKLIST.has('.local')).toBe(false)
  })
})

describe('buildExcludePathPrefixes', () => {
  it('returns root-relative POSIX prefixes', () => {
    expect(
      buildExcludePathPrefixes('/home/u/repo', [
        '/home/u/repo/packages/app',
        '/home/u/repo/worktrees/b'
      ])
    ).toEqual(['packages/app', 'worktrees/b'])
  })

  it('ignores malformed input', () => {
    expect(buildExcludePathPrefixes('/home/u/repo', undefined)).toEqual([])
    expect(buildExcludePathPrefixes('/home/u/repo', 'not-array' as unknown)).toEqual([])
    expect(buildExcludePathPrefixes('/home/u/repo', [null, 42, '', '/outside'])).toEqual([])
  })

  it('ignores root-equal and outside-root values', () => {
    expect(buildExcludePathPrefixes('/home/u/repo', ['/home/u/repo'])).toEqual([])
    expect(buildExcludePathPrefixes('/home/u/repo', ['/home/u/other'])).toEqual([])
  })

  it('keeps dot-dot-prefixed names inside the root while rejecting parent escapes', () => {
    expect(
      buildExcludePathPrefixes('/home/u/repo', [
        '/home/u/repo/..env',
        '/home/u/repo/..workspace/app',
        '/home/u/repo/../outside'
      ])
    ).toEqual(['..env', '..workspace/app'])
  })

  it('handles Windows-style roots and paths', () => {
    expect(buildExcludePathPrefixes('C:\\repo', ['C:\\repo\\packages\\app'])).toEqual([
      'packages/app'
    ])
    expect(
      buildExcludePathPrefixes('//Server/Share/Repo', ['//server/share/repo/packages/app'])
    ).toEqual(['packages/app'])
  })

  it('strips trailing slashes', () => {
    expect(buildExcludePathPrefixes('/r', ['/r/a/', '/r/b///'])).toEqual(['a', 'b'])
  })

  it('keeps valid child prefixes whose segment starts with dotdot characters', () => {
    expect(buildExcludePathPrefixes('/home/u/repo', ['/home/u/repo/..fixtures'])).toEqual([
      '..fixtures'
    ])
  })
})

describe('shouldExcludeQuickOpenRelPath', () => {
  it('matches exact and boundary paths only', () => {
    expect(shouldExcludeQuickOpenRelPath('packages/app', ['packages/app'])).toBe(true)
    expect(shouldExcludeQuickOpenRelPath('packages/app/x.ts', ['packages/app'])).toBe(true)
  })

  it('does not match sibling paths with a shared prefix', () => {
    expect(shouldExcludeQuickOpenRelPath('packages/app2/x.ts', ['packages/app'])).toBe(false)
    expect(shouldExcludeQuickOpenRelPath('packages/application', ['packages/app'])).toBe(false)
  })
})

describe('normalizeQuickOpenRgLine', () => {
  it('strips absolute root prefix', () => {
    expect(
      normalizeQuickOpenRgLine('/root/src/a.ts', { kind: 'absolute', rootPath: '/root' })
    ).toBe('src/a.ts')
  })

  it('strips Windows drive absolute root prefixes', () => {
    expect(
      normalizeQuickOpenRgLine('C:\\repo\\src\\a.ts', {
        kind: 'absolute',
        rootPath: 'C:\\repo'
      })
    ).toBe('src/a.ts')
  })

  it('preserves Windows UNC roots while stripping absolute root prefixes', () => {
    expect(
      normalizeQuickOpenRgLine('\\\\server\\share\\repo\\src\\a.ts', {
        kind: 'absolute',
        rootPath: '\\\\server\\share\\repo'
      })
    ).toBe('src/a.ts')
  })

  it('strips ./ prefix in cwd-relative mode', () => {
    expect(normalizeQuickOpenRgLine('./src/a.ts', { kind: 'cwd-relative' })).toBe('src/a.ts')
  })

  it('keeps cwd-relative dot-dot-prefixed names but rejects parent escapes', () => {
    expect(normalizeQuickOpenRgLine('./..fixtures/a.ts', { kind: 'cwd-relative' })).toBe(
      '..fixtures/a.ts'
    )
    expect(normalizeQuickOpenRgLine('..env', { kind: 'cwd-relative' })).toBe('..env')
    expect(normalizeQuickOpenRgLine('..workspace/file.ts', { kind: 'cwd-relative' })).toBe(
      '..workspace/file.ts'
    )
    expect(normalizeQuickOpenRgLine('../outside.ts', { kind: 'cwd-relative' })).toBeNull()
    expect(normalizeQuickOpenRgLine('..', { kind: 'cwd-relative' })).toBeNull()
  })

  it('strips CRLF', () => {
    expect(normalizeQuickOpenRgLine('/root/a.ts\r', { kind: 'absolute', rootPath: '/root' })).toBe(
      'a.ts'
    )
  })

  it('returns null for paths outside the absolute root', () => {
    expect(
      normalizeQuickOpenRgLine('/other/a.ts', { kind: 'absolute', rootPath: '/root' })
    ).toBeNull()
  })

  it('returns null for empty or root-equal lines', () => {
    expect(normalizeQuickOpenRgLine('', { kind: 'cwd-relative' })).toBeNull()
    expect(normalizeQuickOpenRgLine('.', { kind: 'cwd-relative' })).toBeNull()
  })

  it('returns null for cwd-relative parent-directory escapes', () => {
    expect(normalizeQuickOpenRgLine('../outside/a.ts', { kind: 'cwd-relative' })).toBeNull()
    expect(normalizeQuickOpenRgLine('./../outside/a.ts', { kind: 'cwd-relative' })).toBeNull()
  })
})

// ─── Why these four are still TypeScript, made executable ────────────
//
// The twin's header records the four refusals in prose. Nothing failed if
// someone ignored it: the parity corpus has no `//` root and no non-ASCII
// Windows path, so `pnpm parity` is green over buildExcludePathPrefixes even
// though the shipped core answers differently. The rows below drive the twin
// AND the real core the global seam binds, pinning both directions — a
// cut-over attempt reddens the disagreement rows, a core drift reddens the
// agreement rows.

describe('buildExcludePathPrefixes cannot cross to the Rust core', () => {
  // Its output is argv (`--glob !<prefix>`, `:(exclude,glob)<prefix>`), so a
  // wrong answer lists a nested worktree's files or prunes a real directory —
  // it does not render wrong, it runs. One row per reason the zero-dep port
  // cannot reproduce `node:path`. Each was measured against BOTH shipped
  // artifacts (wasm and napi), not just the one bound here.
  const refusals = [
    {
      why: 'orca_core::path_flavor has no `//` UNC branch, so it reads a UNC root as POSIX and case-sensitively',
      rootPath: '//Server/Share/Repo',
      excludePaths: ['//server/share/repo/packages/app'],
      twin: ['packages/app'],
      rust: []
    },
    {
      why: 'win32.relative() case-folds over full Unicode; the port folds ASCII only',
      rootPath: 'C:\\РЕПО',
      excludePaths: ['C:\\репо\\packages\\app'],
      twin: ['packages/app'],
      rust: []
    },
    {
      why: 'a cross-drive relative() returns the RESOLVED to-path; the port returns it unnormalized',
      rootPath: 'C:\\repo',
      excludePaths: ['D:\\repo\\a\\..\\b'],
      twin: ['D:/repo/b'],
      rust: ['D:/repo/a/../b']
    }
  ]

  for (const row of refusals) {
    it(`disagrees with the shipped core — ${row.why}`, () => {
      expect(buildExcludePathPrefixes(row.rootPath, row.excludePaths)).toEqual(row.twin)
      const { rootPath, excludePaths } = row
      expect(core('buildExcludePathPrefixes', { rootPath, excludePaths })).toEqual(row.rust)
    })
  }

  it('keeps a relative exclude path the twin drops, because relative() resolves against process.cwd()', () => {
    // Asserted as inequality, not a value: the twin's answer depends on the
    // host's cwd (and drive), the core's never does. That impurity is itself
    // the reason it cannot be a pure Rust core's job.
    const args = { rootPath: 'C:\\repo', excludePaths: ['packages/app'] }
    expect(core('buildExcludePathPrefixes', args)).toEqual(['packages/app'])
    expect(buildExcludePathPrefixes(args.rootPath, args.excludePaths)).not.toEqual(['packages/app'])
  })
})

describe('the three per-file predicates agree with the Rust core', () => {
  // They are held back on COST, not correctness: all three run once per listed
  // file on a path with no result cap and a 10s rg timeout, and each crossing
  // costs ~1.2-2.8us through the codec against ~0.1-0.4us here. These rows
  // keep the correctness half true, so the day a batched arm makes the cost
  // go away the cut-over is a routing change and nothing else.
  const paths = [
    'src/index.ts',
    '.github/workflows/ci.yml',
    '.env',
    'node_modules/a/b.js',
    'packages/x/node_modules/a.js',
    '.git/config',
    'foo/.cache/bar',
    '.local/share/app/state.db',
    'nested/.local/share/app/state.db',
    '.local/shared/app',
    '.local/bin/tool',
    '',
    'a//b',
    'a/𝟘/b',
    `a/${'A'.repeat(300)}/b`
  ]
  const prefixLists: readonly string[][] = [[], [''], ['packages/app'], ['a', 'packages/app']]
  const lines = [
    '/root/src/a.ts',
    '/root/src/a.ts\r',
    '/root/',
    '/other/a.ts',
    'C:\\repo\\src\\a.ts',
    '\\\\server\\share\\repo\\src\\a.ts',
    './src/a.ts',
    '.',
    '..',
    '..env',
    '../outside.ts',
    ''
  ]
  const modes: RgOutputMode[] = [
    { kind: 'cwd-relative' },
    { kind: 'absolute', rootPath: '/root' },
    { kind: 'absolute', rootPath: 'C:\\repo' },
    { kind: 'absolute', rootPath: '\\\\server\\share\\repo' }
  ]

  it('shouldIncludeQuickOpenPath', () => {
    for (const path of paths) {
      expect(core('shouldIncludeQuickOpenPath', { path })).toBe(shouldIncludeQuickOpenPath(path))
    }
  })

  it('shouldExcludeQuickOpenRelPath', () => {
    for (const relPath of paths) {
      for (const excludePathPrefixes of prefixLists) {
        expect(core('shouldExcludeQuickOpenRelPath', { relPath, excludePathPrefixes })).toBe(
          shouldExcludeQuickOpenRelPath(relPath, excludePathPrefixes)
        )
      }
    }
  })

  it('normalizeQuickOpenRgLine', () => {
    for (const rawLine of lines) {
      for (const outputMode of modes) {
        expect(core('normalizeQuickOpenRgLine', { rawLine, outputMode })).toEqual(
          normalizeQuickOpenRgLine(rawLine, outputMode)
        )
      }
    }
  })

  it('would catch a divergence — the same rows against the idioms a port gets wrong', () => {
    // A green comparison proves nothing unless it can go red. Each of these is
    // a real substitution class: `\s` splitting for `/`, a raw startsWith for
    // the segment boundary, and a scalar-wise CR strip.
    const bySpace = (path: string): boolean =>
      !path.split(/\s+/).some((s) => s === 'node_modules' || HIDDEN_DIR_BLOCKLIST.has(s))
    const unbounded = (relPath: string, prefixes: readonly string[]): boolean =>
      prefixes.some((prefix) => relPath.startsWith(prefix))
    const keepCr = (rawLine: string, mode: RgOutputMode): string | null =>
      normalizeQuickOpenRgLine(rawLine.replace(/\r$/, '\r '), mode)

    expect(paths.some((p) => core('shouldIncludeQuickOpenPath', { path: p }) !== bySpace(p))).toBe(
      true
    )
    expect(
      paths.some((relPath) =>
        prefixLists.some(
          (excludePathPrefixes) =>
            core('shouldExcludeQuickOpenRelPath', { relPath, excludePathPrefixes }) !==
            unbounded(relPath, excludePathPrefixes)
        )
      )
    ).toBe(true)
    expect(
      lines.some((rawLine) =>
        modes.some(
          (outputMode) =>
            core('normalizeQuickOpenRgLine', { rawLine, outputMode }) !==
            keepCr(rawLine, outputMode)
        )
      )
    ).toBe(true)
  })
})
