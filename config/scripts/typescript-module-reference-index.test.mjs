// Proves the cheap path answers the same question as the expensive one, on the
// real repository. The gates only get to skip ~99% of the tree because this
// test keeps the prefilter honest.
//
// The subject modules are DISCOVERED from the current tree, never named. A
// hardcoded `src/shared/…` fixture is the maintainer's code, not the test's:
// renaming it turns this suite red for a reason that has nothing to do with the
// analysis. Every fixture below comes from
// `typescript-reexport-fixture-discovery.mjs`, which parses the tree with its
// own re-export reader, so the comparisons here are differential rather than
// self-confirming. If the tree holds no qualifying file, discovery throws a
// NoFixtureInTreeError that says so in as many words.

import { describe, expect, it } from 'vitest'

import {
  candidateFilesFor,
  createSymbolTarget,
  displayPath,
  findTargetReferences,
  getFullProject,
  getProjectScan,
  getScopedProject,
  laundererClosure,
  normalizeProgramPath,
  programCacheTimings,
  releaseFullProject,
  scanImportGraph
} from './typescript-symbol-resolution.mjs'
import {
  createModuleFactsReader,
  findImportedButNotReexported,
  findLaunderingBarrel,
  findReferencedExportModule
} from './typescript-reexport-fixture-discovery.mjs'

const referenceKey = (hit) => `${normalizeProgramPath(hit.sourceFile.fileName)}#${hit.node.pos}`

// Why: relay is the smallest real project, and the soundness evidence it gives
// is the same as node's — a full node Program plus an exhaustive walk is ~18s
// and ~4GB, which does not belong in the unit suite. Only relay is compared
// automatically; node, web and cli are NOT, so the equality result here is
// evidence for relay and an assumption everywhere else.
describe('prefilter vs exhaustive scan (relay project)', () => {
  const projectId = 'relay'
  const scan = getProjectScan(projectId)
  const graph = scanImportGraph(scan)
  const prefilterBudget = scan.fileNames.length / 20
  const seam = findReferencedExportModule(scan, graph, {
    withinBudget: (moduleKey) =>
      candidateFilesFor(scan, moduleKey).candidates.length < prefilterBudget
  })

  it('finds exactly the same references as a full-Program walk', () => {
    const { candidates } = candidateFilesFor(scan, seam.moduleKey)
    const scoped = getScopedProject(projectId, candidates)
    const full = getFullProject(projectId)
    const subject = `${displayPath(seam.modulePath)} [${seam.exportNames.join(', ')}]`
    try {
      let compared = 0
      for (const exportName of seam.exportNames) {
        const target = createSymbolTarget(full, { moduleFile: seam.modulePath, exportName })
        const exhaustive = new Set(
          findTargetReferences(full, target, { files: null }).map(referenceKey)
        )
        const prefiltered = new Set(findTargetReferences(scoped, target).map(referenceKey))
        expect(
          [...exhaustive].filter((key) => !prefiltered.has(key)),
          `missed by prefilter: ${subject}`
        ).toEqual([])
        expect(
          [...prefiltered].filter((key) => !exhaustive.has(key)),
          `invented by prefilter: ${subject}`
        ).toEqual([])
        compared += exhaustive.size
      }
      expect(compared, `discovered subject ${subject} has no references at all`).toBeGreaterThan(0)
      expect(candidates.length).toBeLessThan(prefilterBudget)
    } finally {
      releaseFullProject(projectId)
    }
  })
})

describe('re-export laundering is followed through real barrels', () => {
  const scan = getProjectScan('cli')
  const graph = scanImportGraph(scan)
  const readFacts = createModuleFactsReader(scan)
  // `export … from './origin'` and a bare `export { imported }` are different
  // code paths — the second carries no module specifier at all — so both shapes
  // are discovered and both are asserted.
  const fromBarrel = findLaunderingBarrel(scan, graph, { kind: 'from', readFacts })
  const localBarrel = findLaunderingBarrel(scan, graph, { kind: 'local', readFacts })
  const describeBarrel = (barrel) =>
    `${displayPath(barrel.barrelPath)} <- ${displayPath(barrel.originPath)}`

  for (const barrel of [fromBarrel, localBarrel]) {
    const shape =
      barrel.kind === 'from' ? '`export … from`' : '`export { imported }` with no module specifier'

    it(`follows ${shape}`, () => {
      const closure = laundererClosure(scan, graph, barrel.originKey)
      expect(closure, describeBarrel(barrel)).toContain(barrel.originKey)
      expect(closure, describeBarrel(barrel)).toContain(barrel.barrelKey)
    })

    it(`makes importers of the ${shape} barrel candidates for the origin module`, () => {
      // Why: compare against candidateKeys, not candidates — candidates carries
      // on-disk spellings because a Program needs them, while the graph is keyed
      // case-folded, so only candidateKeys is an identity set.
      const { candidateKeys } = candidateFilesFor(scan, barrel.originKey)
      expect(barrel.importerKeys.length, describeBarrel(barrel)).toBeGreaterThan(0)
      for (const importerKey of barrel.importerKeys) {
        expect(
          candidateKeys.has(importerKey),
          `${importerKey} missing for ${describeBarrel(barrel)}`
        ).toBe(true)
      }
    })
  }

  it('does not launder a module the barrel merely imports into the closure', () => {
    // The discriminating negative: the barrel imports this module, so an
    // "importers of importers" closure would wrongly pull the barrel in.
    const unrelated = findImportedButNotReexported(scan, graph, fromBarrel.barrelKey, readFacts)
    const closure = laundererClosure(scan, graph, unrelated.moduleKey)
    expect(
      closure,
      `${displayPath(fromBarrel.barrelPath)} imports ${displayPath(unrelated.modulePath)}`
    ).not.toContain(fromBarrel.barrelKey)
  })
})

describe('the graph sees every file the gates are responsible for', () => {
  it('scans at least the project file list, plus its repo-internal imports', () => {
    const scan = getProjectScan('relay')
    const graph = scanImportGraph(scan)
    for (const key of scan.fileKeys) {
      expect(graph.scannedFiles.has(key)).toBe(true)
    }
    expect(graph.scannedFiles.size).toBeGreaterThanOrEqual(scan.fileKeys.size)
  })
})

describe('cost stays inside the lint budget', () => {
  it('keeps scoped Program construction well under a full Program', () => {
    const scoped = programCacheTimings().filter((entry) => entry.kind === 'scoped')
    const full = programCacheTimings().filter((entry) => entry.kind === 'full')
    expect(scoped.length).toBeGreaterThan(0)
    for (const entry of scoped) {
      expect(entry.roots).toBeLessThan(getProjectScan(entry.id).fileNames.length / 20)
    }
    if (full.length > 0) {
      const slowestScoped = Math.max(...scoped.map((entry) => entry.ms))
      const slowestFull = Math.max(...full.map((entry) => entry.ms))
      expect(slowestScoped).toBeLessThan(slowestFull)
    }
  })
})
