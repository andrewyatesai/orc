// The named input cells `quick-open-filter`'s crossing is measured over, and the
// three answer images the measurement reports separately.
//
// SHAPE, NOT CALL COUNT. A big denominator looks exhaustive and still misses a
// whole input shape, so every axis below is a list of NAMED cells, the suite runs
// their complete cross product, and what the axes do not reach is written down in
// `quick-open-filter-crossing.test.ts` instead of left implicit.
//
// The three images are computed and reported separately because that is the
// standard, but this module CANNOT make two of them differ and the report says so
// rather than implying coverage it does not have: every answer here is a boolean,
// a string, `null`, or a `string[]`. No export returns an object, so key order and
// an own property holding `undefined` — the only two classes BYTE and STRICT add
// over VALUE — have nowhere to live. A thrown answer is the one thing that does
// move all three at once, and one cell (`unknown-kind`) produces it.

export type Cell<T> = { name: string; value: T }

function cell<T>(name: string, value: T): Cell<T> {
  return { name, value }
}

/** AXIS: a `/`-separated root-relative path, as `shouldIncludeQuickOpenPath` and
 *  `shouldExcludeQuickOpenRelPath` read it. One cell per class the segment walk,
 *  the `.local/share` containment test and the codec can tell apart. */
export const PATH_CELLS: Cell<string>[] = [
  cell('plain', 'src/index.ts'),
  cell('plain-deep', 'a/b/c/d/e/f.ts'),
  cell('single-segment', 'README.md'),
  cell('empty', ''),
  cell('space', ' '),
  cell('whitespace-only', ' \t '),
  cell('slash-only', '/'),
  cell('leading-slash', '/src/a.ts'),
  cell('trailing-slash', 'src/'),
  cell('trailing-slash-multi', 'src///'),
  cell('double-slash-mid', 'a//b'),
  cell('dot-segment', 'a/./b'),
  cell('dot-only', '.'),
  cell('dotdot-only', '..'),
  cell('dotdot-segment', 'a/../b'),
  cell('dotdot-name', '..env'),
  cell('dotdot-name-dir', '..workspace/app'),
  cell('backslash-in-posix-name', 'a/b\\c/d.ts'),
  cell('backslash-separators', 'a\\b\\c.ts'),
  cell('windows-drive-fwd', 'C:/repo/a.ts'),
  cell('windows-drive-back', 'C:\\repo\\a.ts'),
  cell('unc-fwd', '//server/share/a.ts'),
  cell('unc-back', '\\\\server\\share\\a.ts'),
  cell('blocked-node_modules-head', 'node_modules/a/b.js'),
  cell('blocked-node_modules-mid', 'packages/x/node_modules/a.js'),
  cell('blocked-node_modules-tail', 'packages/x/node_modules'),
  cell('blocked-dotgit', '.git/config'),
  cell('blocked-dotcache-mid', 'foo/.cache/bar'),
  cell('blocked-npm', '.npm/pkg/index.js'),
  cell('blocked-npm-global', '.npm-global/bin/foo'),
  cell('blocked-gvfs', '.gvfs/mount/file'),
  cell('blocked-path-local-share', '.local/share/app/state.db'),
  cell('blocked-path-local-share-nested', 'nested/.local/share/app/state.db'),
  cell('blocked-path-local-share-tail', 'x/.local/share'),
  cell('blocked-path-local-share-exact', '.local/share'),
  cell('nearmiss-local-shared', '.local/shared/app'),
  cell('nearmiss-local-bin', '.local/bin/tool'),
  cell('nearmiss-node_modules2', 'node_modules2/a.js'),
  cell('nearmiss-dotgithub', '.github/workflows/ci.yml'),
  cell('nearmiss-dotenv', '.env'),
  cell('nearmiss-substring', 'my.git/config'),
  cell('nearmiss-suffix-seg', 'x/node_modules.bak/a'),
  cell('nonascii-latin', 'src/Café/a.ts'),
  cell('nonascii-cyrillic', 'src/ПАПКА/a.ts'),
  cell('nonascii-cjk', 'src/日本語/a.ts'),
  cell('astral-emoji', 'src/🚀/a.ts'),
  cell('astral-math', 'a/𝟘/b'),
  cell('combining-nfd', 'src/Cafe\u0301/a.ts'),
  cell('rtl', 'src/عربى/a.ts'),
  cell('nul', 'a/\u0000/b'),
  cell('bom', '\ufeffsrc/a.ts'),
  cell('nel', 'a/\u0085/b'),
  cell('lf-inside', 'a/\n/b'),
  cell('cr-inside', 'a/\r/b'),
  cell('long-segment', `a/${'A'.repeat(300)}/b`),
  cell('many-segments', Array.from({ length: 64 }, (_, index) => `s${index}`).join('/')),
  cell('lone-surrogate-high', 'src/\ud800/a.ts'),
  cell('lone-surrogate-low', 'src/\udc00/a.ts'),
  cell('paired-surrogate', 'src/\ud83d\ude80/a.ts')
]

/** AXIS: the exclude-prefix list `shouldExcludeQuickOpenRelPath` scans. Covers the
 *  boundary a raw `startsWith` would break, plus the shapes serde reads
 *  differently from the twin. */
export const PREFIX_CELLS: Cell<readonly string[]>[] = [
  cell('none', []),
  cell('empty-string', ['']),
  cell('one', ['packages/app']),
  cell('one-slash-suffixed', ['packages/app/']),
  cell('two', ['a', 'packages/app']),
  cell('prefix-of-path', ['src']),
  cell('sibling-prefix', ['packages/ap']),
  cell('exact-full', ['src/index.ts']),
  cell('nonascii', ['src/Café']),
  cell('astral', ['src/🚀']),
  cell('backslash', ['a\\b']),
  cell('dotdot', ['..']),
  cell('root-slash', ['/']),
  cell('long', ['A'.repeat(300)])
]

/** AXIS: one line of rg `--files` stdout, including the malformed shapes a
 *  truncated buffer, a Windows CRLF and a symlink escape produce. */
export const LINE_CELLS: Cell<string>[] = [
  cell('plain', 'src/a.ts'),
  cell('dot-slash', './src/a.ts'),
  cell('dot-slash-dotdot-name', './..fixtures/a.ts'),
  cell('dot-only', '.'),
  cell('dotdot-only', '..'),
  cell('dotdot-name', '..env'),
  cell('escape', '../outside.ts'),
  cell('escape-via-dot-slash', './../outside/a.ts'),
  cell('empty', ''),
  cell('cr-only', '\r'),
  cell('crlf-tail', 'src/a.ts\r'),
  cell('crlf-tail-double', 'src/a.ts\r\r'),
  cell('lf-inside', 'src/a\nb.ts'),
  cell('abs-posix', '/root/src/a.ts'),
  cell('abs-posix-crlf', '/root/a.ts\r'),
  cell('abs-posix-other-root', '/other/a.ts'),
  cell('abs-posix-root-equal', '/root'),
  cell('abs-posix-root-slash', '/root/'),
  cell('abs-posix-root-escape', '/root/../x'),
  cell('abs-drive-back', 'C:\\repo\\src\\a.ts'),
  cell('abs-drive-fwd', 'C:/repo/src/a.ts'),
  cell('abs-drive-case', 'c:\\repo\\src\\a.ts'),
  cell('abs-unc-back', '\\\\server\\share\\repo\\src\\a.ts'),
  cell('abs-unc-fwd', '//server/share/repo/src/a.ts'),
  cell('backslash-in-posix-name', '/root/a\\b.ts'),
  cell('leading-slash-rel', '/src/a.ts'),
  cell('double-slash', '//root//a.ts'),
  cell('space-only', ' '),
  cell('nonascii', '/root/Café/a.ts'),
  cell('astral', '/root/🚀/a.ts'),
  cell('bom', '\ufeff/root/a.ts'),
  cell('long', `/root/${'A'.repeat(300)}.ts`),
  cell('lone-surrogate', '/root/\ud800.ts')
]

/** AXIS: the output mode. `unknown-kind` is OUT OF TYPE and unreachable from
 *  either caller — kept because it is the one cell that separates the twin (which
 *  dereferences `rootPath` and throws) from the core (which reads an unknown
 *  discriminant as cwd-relative). */
export const MODE_CELLS: Cell<unknown>[] = [
  cell('cwd-relative', { kind: 'cwd-relative' }),
  cell('abs-posix', { kind: 'absolute', rootPath: '/root' }),
  cell('abs-posix-trailing', { kind: 'absolute', rootPath: '/root/' }),
  cell('abs-posix-trailing-multi', { kind: 'absolute', rootPath: '/root///' }),
  cell('abs-drive-back', { kind: 'absolute', rootPath: 'C:\\repo' }),
  cell('abs-drive-fwd', { kind: 'absolute', rootPath: 'C:/repo' }),
  cell('abs-unc-back', { kind: 'absolute', rootPath: '\\\\server\\share\\repo' }),
  cell('abs-unc-fwd', { kind: 'absolute', rootPath: '//server/share/repo' }),
  cell('abs-empty-root', { kind: 'absolute', rootPath: '' }),
  cell('abs-slash-root', { kind: 'absolute', rootPath: '/' }),
  cell('abs-nonascii-root', { kind: 'absolute', rootPath: '/root/Café' }),
  cell('unknown-kind', { kind: 'nope' })
]

// --- the three answer images ---

/** A thrown answer compares like any other answer. */
export function callImage(call: () => unknown): { ok: boolean; value: unknown; thrown: string } {
  try {
    return { ok: true, value: call(), thrown: '' }
  } catch (error) {
    return { ok: false, value: undefined, thrown: `${(error as Error).name}` }
  }
}

export type Answer = ReturnType<typeof callImage>

/** BYTE — `JSON.stringify`. Key ORDER counts; own-`undefined` is dropped. */
export function byteImage(answer: Answer): string {
  return answer.ok ? (JSON.stringify(answer.value) ?? 'undefined') : `THREW ${answer.thrown}`
}

/** VALUE — keys sorted, own-`undefined` dropped. What every consumer reads. */
export function valueImage(answer: Answer): string {
  return answer.ok ? sortedJson(answer.value) : `THREW ${answer.thrown}`
}

/** STRICT — key order counts AND an own `undefined` is distinguished from absent. */
export function strictImage(answer: Answer): string {
  return answer.ok ? strictJson(answer.value) : `THREW ${answer.thrown}`
}

function sortedJson(value: unknown): string {
  if (value === undefined) {
    return 'undefined'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(sortedJson).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${sortedJson(member)}`)
  return `{${entries.join(',')}}`
}

function strictJson(value: unknown): string {
  if (value === undefined) {
    return 'undefined'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(strictJson).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([key, member]) => `${JSON.stringify(key)}:${strictJson(member)}`
  )
  return `{${entries.join(',')}}`
}
