// Why `quick-open-filter`'s four remaining exports are still TypeScript, made
// executable instead of left as prose in the twin's header.
//
// Nothing failed if a reader ignored that prose. `pnpm parity`'s corpus has no
// `//` root and no non-ASCII Windows path, so it is green over
// `buildExcludePathPrefixes` even though both shipped cores answer differently;
// and no suite anywhere measured what a per-line crossing costs. The rows below
// drive the twin AND the real core, in both directions:
//
//  * the DISAGREEMENT rows go red when the Rust port closes a gap — which is
//    exactly when the refusal has gone stale and the export should be revisited.
//  * the AGREEMENT rows go red when the core drifts from the twin, which keeps
//    the correctness half of the three predicates true so that the day a BATCHED
//    dispatch arm exists their cut-over is a routing change and nothing else.
//  * the staleness row goes red the day that batched arm appears.
//
// THIS IS A TWO-WAY MEASUREMENT, NOT THE FOUR-WAY ONE, and the difference is not
// cosmetic. Four-way (reference unbound, shim unbound, reference bound, shim
// bound) exists to catch a pre-ready fallback that has drifted from the body it
// copied. There is no shim in this module and therefore no fourth implementation
// to catch: the production path IS the twin, on every surface, bound or not. When
// one of these exports does cross, the suite that lands with it owes four legs.
//
// WHICH ARTIFACT. These rows bind the embedded wasm blob, the same choice
// `commit-message-agent-spec-shape-coverage.test.ts` makes. Every count quoted in
// the twin's header was taken against BOTH shipped artifacts — `orca_node.node`
// as well — by `config/scripts/quick-open-filter-crossing-cost.mjs`, and the two
// agreed on every input; `pnpm parity`'s Rust leg re-checks the natively built
// crate on every run.
//
// WHAT THESE AXES DO NOT REACH, named rather than implied:
//  * Path text outside the 59 named cells. The space is infinite; the cells are
//    one per branch of the segment walk, the `.local/share` containment test, the
//    separator handling and the codec's refusal set.
//  * Exclude-prefix lists longer than 2, and prefix ORDER beyond the two-element
//    cell. Both sides scan linearly and return on the first hit, so a third
//    element adds an iteration, not a branch — an argument, not a proof.
//  * Root paths for `buildExcludePathPrefixes` beyond the 28 x 75 grid the cost
//    script sweeps; this file keeps only the exemplars of the three classes.
//  * Lone surrogates ACROSS THE SEAM. The codec refuses them by design, so those
//    cells prove the refusal, never an agreement. A real Windows directory name
//    can hold one, so a future shim owes them a fallback row instead.
//  * The napi addon (see above), Electron's own V8, and a 32-bit host.
//  * Rebinding the seam mid-call, and concurrent callers.
import { afterAll, describe, expect, it } from 'vitest'
import { DispatchPayloadError } from './dispatch-payload-codec'
import { setOrcaDispatchBinding, tryOrcaDispatch, type OrcaDispatchFn } from './orca-dispatch-seam'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import {
  buildExcludePathPrefixes,
  HIDDEN_DIR_BLOCKLIST,
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath,
  type RgOutputMode
} from './quick-open-filter'
import {
  buildGitLsFilesArgsForQuickOpen,
  buildHiddenDirExcludeGlobs,
  buildRgArgsForQuickOpen
} from './quick-open-listing-arguments'
import {
  byteImage,
  callImage,
  LINE_CELLS,
  MODE_CELLS,
  PATH_CELLS,
  PREFIX_CELLS,
  strictImage,
  valueImage
} from './quick-open-filter-crossing-cells'

const wasmBinding: OrcaDispatchFn = (module, fn, inputJson) => orcaDispatch(module, fn, inputJson)

afterAll(() => setOrcaDispatchBinding(wasmBinding))

/** `REFUSED` is what the codec answers for a payload that cannot cross at all —
 *  kept apart from every real answer, because a refusal is not a disagreement. */
const REFUSED = Symbol('the dispatch codec refused this payload')

function core(fn: string, input: unknown): unknown | typeof REFUSED {
  try {
    return tryOrcaDispatch('quick-open-filter', fn, input)
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return REFUSED
    }
    throw error
  }
}

// ─── buildExcludePathPrefixes: the three classes, re-derived ─────────

describe('buildExcludePathPrefixes cannot cross', () => {
  // Its answer becomes `--glob !<prefix>` and `:(exclude,glob)<prefix>`, i.e.
  // argv of a spawned rg / git ls-files. A wrong answer does not render wrong,
  // it RUNS: a dropped prefix lists a nested worktree's files as this
  // workspace's, and an invented one prunes a directory the user wanted.
  const classes = [
    {
      klass: 1,
      why: '`orca_core::path_flavor` has no `//` branch, so it reads a UNC root as POSIX and compares case-sensitively',
      rootPath: '//Server/Share/Repo',
      excludePaths: ['//server/share/repo/packages/app'],
      twin: ['packages/app'],
      rust: []
    },
    {
      klass: 3,
      why: '`win32.relative()` case-folds the whole path with full-Unicode toLowerCase; the port folds ASCII only',
      rootPath: 'C:\\РЕПО',
      excludePaths: ['C:\\репо\\packages\\app'],
      twin: ['packages/app'],
      rust: []
    },
    {
      klass: 3,
      why: 'a cross-drive `relative()` returns the RESOLVED to-path; the port returns it unnormalised',
      rootPath: 'C:\\repo',
      excludePaths: ['D:\\repo\\a\\..\\b'],
      twin: ['D:/repo/b'],
      rust: ['D:/repo/a/../b']
    }
  ]

  for (const row of classes) {
    it(`class ${row.klass} — ${row.why}`, () => {
      expect(buildExcludePathPrefixes(row.rootPath, row.excludePaths)).toEqual(row.twin)
      const { rootPath, excludePaths } = row
      expect(core('buildExcludePathPrefixes', { rootPath, excludePaths })).toEqual(row.rust)
    })
  }

  it('class 2 — `relative()` resolves both operands against process.cwd(), so the twin is not pure', () => {
    // Asserted as a RELATION, not a value: the twin's answer here depends on the
    // host's working directory, which is why no pure core can reproduce it by
    // construction rather than by a missing feature. This is the class that
    // cannot be closed by porting harder.
    const rootPath = 'C:\\repo'
    const excludePaths = ['packages/app']
    expect(core('buildExcludePathPrefixes', { rootPath, excludePaths })).toEqual(['packages/app'])
    expect(buildExcludePathPrefixes(rootPath, excludePaths)).toEqual([])
    // And the twin's own answer moves with cwd, which is the impurity itself.
    expect(buildExcludePathPrefixes(process.cwd(), [`${process.cwd()}/packages/app`])).toEqual([
      'packages/app'
    ])
  })

  it('an "absolute, non-// root" gate does NOT rescue it', () => {
    // The obvious shim contract — cross only when the root looks absolute and
    // Windows-shaped — still admits classes 2 and 3.
    const gated = (rootPath: string): boolean =>
      /^([a-zA-Z]:[\\/]|\\\\)/.test(rootPath) || rootPath.startsWith('/')
    const attacks: { rootPath: string; excludePaths: string[] }[] = [
      { rootPath: 'C:\\РЕПО', excludePaths: ['C:\\репо\\packages\\app'] },
      { rootPath: 'C:\\CAFÉ', excludePaths: ['C:\\café\\app'] },
      { rootPath: 'C:\\ünï', excludePaths: ['C:\\ÜNÏ\\app'] },
      { rootPath: 'C:\\repo', excludePaths: ['D:\\repo\\a\\..\\b'] },
      { rootPath: 'C:\\repo', excludePaths: ['D:\\x\\.\\y'] }
    ]
    const survivors = attacks.filter(({ rootPath, excludePaths }) => {
      const crossed = JSON.stringify(core('buildExcludePathPrefixes', { rootPath, excludePaths }))
      const twin = JSON.stringify(buildExcludePathPrefixes(rootPath, excludePaths))
      return gated(rootPath) && crossed !== twin
    })
    expect(survivors.length).toBe(attacks.length)
  })
})

// ─── the three per-file predicates: correctness is NOT the blocker ───

type Probe = { name: string; fn: string; input: unknown; twin: () => unknown }

function probes(): Probe[] {
  const list: Probe[] = []
  for (const path of PATH_CELLS) {
    list.push({
      name: `shouldIncludeQuickOpenPath[${path.name}]`,
      fn: 'shouldIncludeQuickOpenPath',
      input: { path: path.value },
      twin: () => shouldIncludeQuickOpenPath(path.value)
    })
    for (const prefixes of PREFIX_CELLS) {
      list.push({
        name: `shouldExcludeQuickOpenRelPath[${path.name}][${prefixes.name}]`,
        fn: 'shouldExcludeQuickOpenRelPath',
        input: { relPath: path.value, excludePathPrefixes: [...prefixes.value] },
        twin: () => shouldExcludeQuickOpenRelPath(path.value, prefixes.value)
      })
    }
  }
  for (const line of LINE_CELLS) {
    for (const mode of MODE_CELLS) {
      list.push({
        name: `normalizeQuickOpenRgLine[${line.name}][${mode.name}]`,
        fn: 'normalizeQuickOpenRgLine',
        input: { rawLine: line.value, outputMode: mode.value },
        twin: () => normalizeQuickOpenRgLine(line.value, mode.value as RgOutputMode)
      })
    }
  }
  return list
}

/** The one OUT-OF-TYPE cell where the twin and the core are known to part ways.
 *  Declared here, not discovered in the diff. */
function expectedToAgree(probe: Probe): boolean {
  return !probe.name.includes('[unknown-kind]')
}

describe('the three per-file predicates agree with the shipped core', () => {
  const rows = probes().map((probe) => {
    const twinAnswer = callImage(probe.twin)
    const crossed = core(probe.fn, probe.input)
    const coreAnswer = callImage(() => crossed)
    return {
      name: probe.name,
      refused: crossed === REFUSED,
      twin: {
        byte: byteImage(twinAnswer),
        value: valueImage(twinAnswer),
        strict: strictImage(twinAnswer)
      },
      core: {
        byte: byteImage(coreAnswer),
        value: valueImage(coreAnswer),
        strict: strictImage(coreAnswer)
      },
      agrees: expectedToAgree(probe)
    }
  })

  it('runs the complete cross product of the named cells', () => {
    const expected =
      PATH_CELLS.length +
      PATH_CELLS.length * PREFIX_CELLS.length +
      LINE_CELLS.length * MODE_CELLS.length
    expect(rows.length).toBe(expected)
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length)
  })

  it('refuses exactly the lone-surrogate cells, and crosses everything else', () => {
    const refusedNames = rows.filter((row) => row.refused).map((row) => row.name)
    expect(refusedNames.every((name) => name.includes('lone-surrogate'))).toBe(true)
    expect(refusedNames.length).toBeGreaterThan(0)
    // A refusal is not a pass: the twin still answers those, and a future shim
    // owes them its fallback body.
    for (const name of refusedNames) {
      expect(rows.find((row) => row.name === name)?.twin.byte).not.toBe('')
    }
  })

  for (const image of ['byte', 'value', 'strict'] as const) {
    it(`twin vs core — ${image} image`, () => {
      const mismatches = rows
        .filter((row) => !row.refused && row.agrees)
        .filter((row) => row.twin[image] !== row.core[image])
        .map((row) => `${row.name}\n  twin=${row.twin[image]}\n  core=${row.core[image]}`)
      expect({ image, count: mismatches.length, examples: mismatches.slice(0, 5) }).toEqual({
        image,
        count: 0,
        examples: []
      })
    })
  }

  it('the one declared disagreement is the out-of-type output mode, where the twin THROWS', () => {
    // Unreachable from either caller: `getQuickOpenRgOutputMode` returns only the
    // two kinds and the relay passes a `cwd-relative` literal. Kept as the cell
    // that proves the images can move at all — the twin dereferences
    // `outputMode.rootPath`, the core reads an unknown discriminant as
    // cwd-relative. A line that is empty after the CR strip short-circuits before
    // that dereference, so those rows agree; the split is asserted, not assumed.
    const declared = rows.filter((row) => !row.agrees)
    expect(declared.length).toBe(LINE_CELLS.length)
    const crossed = declared.filter((row) => !row.refused)
    const threw = crossed.filter((row) => row.twin.byte === 'THREW TypeError')
    const shortCircuited = crossed.filter(
      (row) => row.twin.byte === 'null' && row.core.byte === 'null'
    )
    expect(threw.length).toBeGreaterThan(0)
    expect(shortCircuited.length).toBeGreaterThan(0)
    expect(threw.length + shortCircuited.length).toBe(crossed.length)
    for (const row of threw) {
      expect(row.core.byte).not.toBe('THREW TypeError')
    }
  })

  it('the corpus is discriminating — the idioms a port gets wrong all redden it', () => {
    // A green comparison proves nothing unless it can go red. Each substitution
    // is a real class: whitespace splitting instead of `/`, an unbounded
    // `startsWith` for the segment boundary, and a CR strip that keeps the CR.
    const bySpace = (path: string): boolean =>
      !path.split(/\s+/).some((s) => s === 'node_modules' || HIDDEN_DIR_BLOCKLIST.has(s))
    const unbounded = (relPath: string, prefixes: readonly string[]): boolean =>
      prefixes.some((prefix) => relPath.startsWith(prefix))
    const keepCr = (rawLine: string, mode: RgOutputMode): string | null =>
      normalizeQuickOpenRgLine(rawLine.replace(/\r$/, '\r '), mode)

    const reddened = { include: 0, exclude: 0, normalize: 0 }
    for (const path of PATH_CELLS) {
      const included = core('shouldIncludeQuickOpenPath', { path: path.value })
      if (included !== REFUSED && included !== bySpace(path.value)) {
        reddened.include += 1
      }
      for (const prefixes of PREFIX_CELLS) {
        const excluded = core('shouldExcludeQuickOpenRelPath', {
          relPath: path.value,
          excludePathPrefixes: [...prefixes.value]
        })
        if (excluded !== REFUSED && excluded !== unbounded(path.value, prefixes.value)) {
          reddened.exclude += 1
        }
      }
    }
    for (const line of LINE_CELLS) {
      for (const mode of MODE_CELLS) {
        if (mode.name === 'unknown-kind') {
          continue
        }
        const normalized = core('normalizeQuickOpenRgLine', {
          rawLine: line.value,
          outputMode: mode.value
        })
        if (normalized !== REFUSED && normalized !== keepCr(line.value, mode.value as RgOutputMode)) {
          reddened.normalize += 1
        }
      }
    }
    expect(reddened.include).toBeGreaterThan(0)
    expect(reddened.exclude).toBeGreaterThan(0)
    expect(reddened.normalize).toBeGreaterThan(0)
  })
})

// ─── what would unblock the three, and who reaches the core today ────

describe('the cost refusal and the reachability it implies', () => {
  it('no BATCHED arm exists yet — the day one does, the three should cross', () => {
    // The three are held back on COST, not correctness: each crossing costs more
    // than the whole TS body, and they run once per listed file. The unblock is a
    // Rust arm that takes a CHUNK of rg output and answers for all of it, so the
    // seam is paid once per chunk. This row is the staleness alarm: it goes red
    // the moment such an arm is registered, which is the signal to cut over.
    for (const name of [
      'filterQuickOpenPaths',
      'normalizeQuickOpenRgLines',
      'filterQuickOpenRgChunk'
    ]) {
      expect(() => core(name, { lines: [], excludePathPrefixes: [] })).toThrowError(
        /the module was reached but the function was not/
      )
    }
    // Control: the alarm has to tell "no such arm" from "no such module", or it
    // would stay green after someone renamed the module key.
    expect(core('shouldIncludeQuickOpenPath', { path: 'src/a.ts' })).toBe(true)
  })

  it('the three ARG-BUILDER arms are reached in production, and these four never are', () => {
    // A refusal is only meaningful if it is actually a refusal: the four exports
    // below must answer locally, and the sibling shim's three must not.
    const reached: string[] = []
    setOrcaDispatchBinding((module, fn, inputJson) => {
      if (module === 'quick-open-filter') {
        reached.push(fn)
      }
      return orcaDispatch(module, fn, inputJson)
    })
    try {
      shouldIncludeQuickOpenPath('src/a.ts')
      shouldExcludeQuickOpenRelPath('src/a.ts', ['packages/app'])
      normalizeQuickOpenRgLine('./src/a.ts', { kind: 'cwd-relative' })
      buildExcludePathPrefixes('/home/u/repo', ['/home/u/repo/packages/app'])
      expect(reached).toEqual([])

      buildHiddenDirExcludeGlobs()
      buildRgArgsForQuickOpen({
        searchRoot: '.',
        excludePathPrefixes: [],
        forceSlashSeparator: false
      })
      buildGitLsFilesArgsForQuickOpen([])
      expect([...reached].sort()).toEqual([
        'buildGitLsFilesArgsForQuickOpen',
        'buildHiddenDirExcludeGlobs',
        'buildRgArgsForQuickOpen'
      ])
    } finally {
      setOrcaDispatchBinding(wasmBinding)
    }
  })
})
