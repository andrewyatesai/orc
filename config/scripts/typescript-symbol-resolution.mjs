// Semantic-query façade for the verification gates. Import this; the split
// underneath is a line-budget detail.
//
// RESOLVING A MERGE CONFLICT HERE? Read
// ./typescript-symbol-resolution.README.md first — it is the 15-second version
// of why this file and its five siblings are worth keeping.
//
// ============================ THE CONTRACT ============================
// A gate built on this module must never ask "does this text appear". It asks
// "what does this identifier resolve to", "is that binding alive at runtime",
// and "is this operation dominated by that guard".
//
// WHAT THIS MODULE GUARANTEES
//   * Identity is declaration identity. `import { w as x }`, `export {y} from`,
//     `import * as ns`, and a local shadow all get the right answer, because
//     none of them change where a symbol is declared.
//   * A reference reported as `isRuntimeValueReference` is a real runtime door:
//     the alias chain contains no `type` hop, the resolved symbol has value
//     meaning, and the reference sits in a value position.
//   * `evaluationDominates(A, B) === true` means A runs before B on every path
//     that reaches B. It is an under-approximation: `false` means "no guarantee
//     found", never "provably unguarded", so gates fail closed.
//   * `uncoveredSourceFiles()` names every on-disk file no Program contains.
//     A gate that ignores it is not checking those files.
//
// WHAT THIS MODULE DOES NOT GUARANTEE (documented non-goals)
//   * Runtime metaprogramming: `eval`, `new Function`, `globalThis[name]`,
//     dynamic property access with a computed key, monkey-patched module
//     namespaces. Nothing static can see these; a gate must treat the
//     capability as out of scope, not as absent.
//   * Indirection through a value: `const f = seam.write; f()` is reported by
//     `runtimeAliasEscapes`, not by `findTargetCallSites`. A gate must fail on
//     a non-empty escape list rather than assume the call sites are complete.
//   * Cross-function dominance. A guard in a helper never counts.
//   * `.d.ts`-only and ambient-module declarations have no file identity; use
//     `callSiteFacts().isAmbient`.
//
// HOW A GATE IS SHAPED
//   forEachModuleScope(seamFile, ALL_PROJECT_IDS, (scope) => {
//     const target = createSymbolTarget(scope.project, { moduleFile: seamFile, exportName })
//     for (const hit of findTargetCallSites(scope.project, target)) { … }
//     for (const hit of runtimeAliasEscapes(scope.project, target)) { fail() }
//   })
//   plus one uncoveredSourceFiles() assertion per run.
//
// COST (measured on this repo, warm page cache, M-series mac, Node 26)
//   scanner import graph   node 0.60s  web 0.67s  cli 0.04s  relay 0.01s  scripts 0.05s
//   scoped Program+checker 0.13-0.44s each, 150-800 files each
//   reference query        ~10ms per exported symbol per project
//   ONE seam, all 5 projects, cold:      ~2.2s, peak RSS ~0.6GB
//   TWO seams, all 5 projects, cold:     ~3.6s, peak RSS ~1.1GB
//   for comparison, the full-Program shape this replaced: ~13s, peak RSS ~3.8GB
// The scanner graph is cached per process, so N GATES MUST RUN IN ONE NODE
// PROCESS: the ~1.4s of graph scanning is paid once, and each further seam
// costs only its scoped Programs (~0.3-0.6s).
//
// WHAT SCOPING COSTS IN COVERAGE
//   A scoped Program contains only the files proved able to reference the seam,
//   so it cannot answer questions about the rest of the tree. It is exact for
//   "every reference to symbol S" — the relay project is compared against a
//   full-Program exhaustive walk by the unit suite. No other project is compared
//   automatically, and this repo has no CI, so that comparison runs only when
//   someone runs the suite. It is NOT a substitute for a whole-program lint.
//
// .mjs COVERAGE DECISION
//   Config scripts are in no tsconfig, so getProjectScan('config-scripts')
//   defines a synthetic allowJs project over config/scripts, tools and private
//   (381 .mjs files). Symbol resolution and dominance work there exactly as for
//   .ts. What is weaker: no type annotations, so constantStringArgument folds
//   less and untyped npm imports resolve to `any`. Identity against a *repo*
//   module is unaffected — that is file-to-file resolution.
// ======================================================================

export {
  ALL_PROJECT_IDS,
  APP_PROJECT_IDS,
  REPO_ROOT,
  SCRIPT_PROJECT_ID,
  createInMemoryProject,
  displayPath,
  forEachFullProject,
  getFullProject,
  getProjectScan,
  getScopedProject,
  normalizeProgramPath,
  programCacheTimings,
  releaseFullProject,
  resetProgramCache,
  uncoveredSourceFiles
} from './typescript-program-cache.mjs'

export {
  createSymbolTarget,
  declarationKey,
  describeReference,
  importBindingIsErased,
  isValuePosition,
  referenceMatchesTarget,
  resolveReference,
  resolvesToTarget,
  unwrapAlias
} from './typescript-symbol-identity.mjs'

export {
  candidateFilesFor,
  forEachModuleScope,
  findTargetCallSites,
  findTargetReferences,
  laundererClosure,
  openModuleScope,
  runtimeAliasEscapes,
  scanImportGraph
} from './typescript-module-reference-index.mjs'

export {
  DOMINANCE_CONTRACT,
  dominatingNodes,
  enclosingFunction,
  evaluationDominates,
  findDominatingCall
} from './typescript-guard-dominance.mjs'

export {
  callSiteFacts,
  constantStringArgument,
  literalStringArgument
} from './typescript-call-site-facts.mjs'
