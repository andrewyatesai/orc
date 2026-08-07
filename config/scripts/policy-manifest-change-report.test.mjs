import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  classifyChangedPaths,
  collectLintChainScripts,
  discoverPolicyFiles,
  extractDataFileLiterals,
  formatPolicyFileList,
  formatReport,
  main,
  parseArguments
} from './policy-manifest-change-report.mjs'

const tempRoots = []

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-policy-cooccurrence-'))
  tempRoots.push(root)
  return root
}

function writeFile(root, relativePath, contents) {
  const absolute = path.join(root, relativePath)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
}

/** A miniature repo: a lint chain with one hop, one baseline, one decoy. */
function makeSyntheticRepo() {
  const root = makeTempRoot()
  writeFile(
    root,
    'package.json',
    JSON.stringify({
      scripts: {
        lint: 'oxlint && pnpm run check:ratchet && node config/scripts/check-styles.mjs',
        'check:ratchet': 'node config/scripts/check-ratchet.mjs',
        'not:in:lint': 'node config/scripts/check-unrelated.mjs'
      }
    })
  )
  writeFile(
    root,
    'config/scripts/check-ratchet.mjs',
    "const BASELINE_PATH = 'config/demo-baseline.txt'\nconst MOBILE = 'mobile/.oxlintrc.json'\n"
  )
  writeFile(
    root,
    'config/scripts/check-styles.mjs',
    "import { read } from './style-manifest-reader.mjs'\nconst missing = 'config/not-on-disk.json'\n"
  )
  writeFile(
    root,
    'config/scripts/style-manifest-reader.mjs',
    "const p = path.join('config', 'demo-styles.jsonc')\nconst cached = path.join('node_modules', '.cache', 'x.json')\n"
  )
  writeFile(
    root,
    'config/scripts/check-unrelated.mjs',
    "const x = 'config/unrelated-allowlist.json'\n"
  )
  writeFile(root, 'config/demo-baseline.txt', 'src/main/big.ts\n')
  writeFile(root, 'config/demo-styles.jsonc', '{}\n')
  writeFile(root, 'config/unrelated-allowlist.json', '[]\n')
  writeFile(root, 'mobile/.oxlintrc.json', '{}\n')
  writeFile(root, 'node_modules/.cache/x.json', '{}\n')
  writeFile(root, '.oxlintrc.json', '{}\n')
  return root
}

describe('collectLintChainScripts', () => {
  it('follows pnpm run hops and collects --config arguments', () => {
    const { scripts, configArgs } = collectLintChainScripts({
      lint: 'oxlint && pnpm run lint:x && node config/scripts/a.mjs',
      'lint:x': 'oxlint --config config/x.json && node config/scripts/b.mjs',
      unrelated: 'node config/scripts/c.mjs'
    })
    expect(scripts).toEqual(['config/scripts/a.mjs', 'config/scripts/b.mjs'])
    expect(configArgs).toEqual(['config/x.json'])
    expect(scripts).not.toContain('config/scripts/c.mjs')
  })

  it('terminates on a self-referential script chain', () => {
    const { scripts } = collectLintChainScripts({
      lint: 'pnpm run lint',
      other: 'node config/scripts/never.mjs'
    })
    expect(scripts).toEqual([])
  })
})

describe('extractDataFileLiterals', () => {
  it('finds plain literals and path.join forms', () => {
    const literals = extractDataFileLiterals(
      "const a = 'config/max-lines-baseline.txt'\nconst b = path.join('config', 'gates.jsonc')\n"
    )
    expect(literals).toContain('config/max-lines-baseline.txt')
    expect(literals).toContain('config/gates.jsonc')
  })

  it('ignores prose that merely mentions a file name', () => {
    const literals = extractDataFileLiterals(
      "console.error('added a per-file bump in mobile/.oxlintrc.json')"
    )
    expect(literals).toEqual([])
  })

  it('ignores path.join calls with a non-literal argument', () => {
    const literals = extractDataFileLiterals("path.join(root, 'config', name + '.json')")
    expect(literals).toEqual([])
  })
})

describe('discoverPolicyFiles', () => {
  it('derives manifests from the lint chain without a hardcoded list', () => {
    const files = discoverPolicyFiles(makeSyntheticRepo()).map((entry) => entry.file)
    expect(files).toContain('config/demo-baseline.txt')
    expect(files).toContain('mobile/.oxlintrc.json')
    expect(files).toContain('config/demo-styles.jsonc') // reached via a local import
  })

  it('names the script that reads each manifest', () => {
    const entry = discoverPolicyFiles(makeSyntheticRepo()).find(
      (candidate) => candidate.file === 'config/demo-baseline.txt'
    )
    expect(entry.referencedBy).toEqual(['config/scripts/check-ratchet.mjs'])
  })

  it('excludes manifests only read outside the lint chain', () => {
    const files = discoverPolicyFiles(makeSyntheticRepo()).map((entry) => entry.file)
    expect(files).not.toContain('config/unrelated-allowlist.json')
  })

  it('excludes referenced paths that do not exist and build-output paths', () => {
    const files = discoverPolicyFiles(makeSyntheticRepo()).map((entry) => entry.file)
    expect(files).not.toContain('config/not-on-disk.json')
    expect(files).not.toContain('node_modules/.cache/x.json')
  })

  it('adds the hand-listed extras, including its own source, and says so', () => {
    const root = makeSyntheticRepo()
    writeFile(root, 'config/scripts/policy-manifest-change-report.mjs', '// copy under test\n')
    const files = discoverPolicyFiles(root)
    const rc = files.find((entry) => entry.file === '.oxlintrc.json')
    expect(rc.referencedBy[0]).toContain('EXTRA_POLICY_FILES')
    expect(files.map((entry) => entry.file)).toContain(
      'config/scripts/policy-manifest-change-report.mjs'
    )
  })

  it('reports nothing rather than throwing when there is no package.json', () => {
    expect(discoverPolicyFiles(makeTempRoot())).toEqual([])
  })
})

describe('classifyChangedPaths', () => {
  const policyFiles = [{ file: 'config/demo-baseline.txt', referencedBy: ['config/scripts/a.mjs'] }]

  it('splits policy, source and other paths', () => {
    const classified = classifyChangedPaths(
      ['src/main/index.ts', 'config/demo-baseline.txt', 'docs/notes.md', 'src/lib.rs'],
      policyFiles
    )
    expect(classified.policy.map((entry) => entry.file)).toEqual(['config/demo-baseline.txt'])
    expect(classified.source).toEqual(['src/lib.rs', 'src/main/index.ts'])
    expect(classified.other).toEqual(['docs/notes.md'])
  })

  it('deduplicates repeated paths', () => {
    const classified = classifyChangedPaths(['src/a.ts', 'src/a.ts'], policyFiles)
    expect(classified.source).toEqual(['src/a.ts'])
  })
})

describe('formatReport', () => {
  const policyFiles = [{ file: 'config/demo-baseline.txt', referencedBy: ['config/scripts/a.mjs'] }]

  it('asks for a human when a manifest changed alongside source', () => {
    const report = formatReport({
      scopeLabel: 'staged changes',
      classified: classifyChangedPaths(
        ['config/demo-baseline.txt', 'src/main/index.ts'],
        policyFiles
      )
    })
    expect(report).toContain('config/demo-baseline.txt')
    expect(report).toContain('src/main/index.ts')
    expect(report).toContain('This needs a human to confirm the policy change is legitimate.')
    expect(report).toContain('evades this report')
  })

  it('does not present a null result as a clean bill of health', () => {
    const report = formatReport({
      scopeLabel: 'staged changes',
      classified: classifyChangedPaths(['src/main/index.ts'], policyFiles),
      policyFileCount: policyFiles.length
    })
    expect(report).toContain('None of the 1 known policy/manifest files changed.')
    expect(report).toContain('derived and incomplete')
    expect(report).not.toContain('needs a human')
  })

  it('lists the derived set with the caveat that it is incomplete', () => {
    const listing = formatPolicyFileList(policyFiles)
    expect(listing).toContain('config/demo-baseline.txt  [read by config/scripts/a.mjs]')
    expect(listing).toContain('invisible to the report')
  })

  it('never claims to have verified or blocked anything', () => {
    const report = formatReport({
      scopeLabel: 'staged changes',
      classified: classifyChangedPaths(
        ['config/demo-baseline.txt', 'src/main/index.ts'],
        policyFiles
      )
    })
    expect(report).toMatch(/review aid, not a gate/)
    for (const forbidden of [/\bverified\b/i, /\bblocked\b/i, /\bfail(ed|s)?\b/i, /\benforce/i]) {
      expect(report).not.toMatch(forbidden)
    }
  })
})

describe('parseArguments', () => {
  it('defaults to staged and understands --range and --files', () => {
    expect(parseArguments([]).mode).toBe('staged')
    expect(parseArguments(['--range', 'main..HEAD'])).toMatchObject({
      mode: 'range',
      range: 'main..HEAD'
    })
    expect(parseArguments(['--files', 'a.ts', 'b.ts']).files).toEqual(['a.ts', 'b.ts'])
  })
})

function captureConsole() {
  const lines = []
  return { lines, log: (line) => lines.push(line), error: (line) => lines.push(line) }
}

describe('main always exits 0', () => {
  it('returns 0 when a manifest changed alongside source', () => {
    const out = captureConsole()
    const status = main(
      ['--files', 'config/demo-baseline.txt', 'src/main/index.ts'],
      makeSyntheticRepo(),
      out
    )
    expect(status).toBe(0)
    expect(out.lines.join('\n')).toContain('This needs a human')
  })

  it('returns 0 when only source changed', () => {
    const out = captureConsole()
    expect(main(['--files', 'src/main/index.ts'], makeSyntheticRepo(), out)).toBe(0)
    expect(out.lines.join('\n')).toContain('known policy/manifest files changed.')
  })

  it('returns 0 for --list-policy-files', () => {
    const out = captureConsole()
    expect(main(['--list-policy-files'], makeSyntheticRepo(), out)).toBe(0)
    expect(out.lines.join('\n')).toContain('config/demo-baseline.txt')
  })

  it('returns 0 when git cannot answer', () => {
    const out = captureConsole()
    expect(main(['--range', 'no-such-ref..HEAD'], makeSyntheticRepo(), out)).toBe(0)
    expect(out.lines.join('\n')).toContain('this tool never fails a build')
  })

  it('returns 0 when the repo it is pointed at is unreadable', () => {
    const root = makeTempRoot()
    writeFile(root, 'package.json', '{ this is not json')
    const out = captureConsole()
    expect(main(['--files', 'src/main/index.ts'], root, out)).toBe(0)
    expect(out.lines.join('\n')).toContain('this tool never fails a build')
  })

  it('reads a real staged change and still returns 0', () => {
    const root = makeSyntheticRepo()
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    git('init', '-q')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Test')
    git('add', '-A')
    git('commit', '-qm', 'base')
    writeFile(root, 'config/demo-baseline.txt', 'src/main/big.ts\nsrc/main/bigger.ts\n')
    writeFile(root, 'src/main/bigger.ts', 'export const x = 1\n')
    git('add', '-A')
    const out = captureConsole()
    expect(main([], root, out)).toBe(0)
    const report = out.lines.join('\n')
    expect(report).toContain('config/demo-baseline.txt')
    expect(report).toContain('src/main/bigger.ts')
    expect(report).toContain('This needs a human')
  })
})
