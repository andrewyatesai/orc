import type { Plugin, Rollup } from 'vite'

type OutputBundle = Rollup.OutputBundle
type OutputChunk = Rollup.OutputChunk


// Why: modules that resolve sibling output files (preloads, workers, the
// orca:// renderer root) used `join(__dirname, '../…')`, which is only correct
// while that code sits in out/main/index.js. When the bundler hoisted it into
// out/main/chunks/, __dirname became out/main/chunks and every such path
// resolved one level too deep — the preload silently failed to load and the
// window rendered the scheme handler's 404 body. Nothing failed at build time.
//
// out-main-directory.ts anchors on the entry module and VERIFIES the result
// instead. This guard keeps it that way: a chunk (never an entry, where
// __dirname is genuinely out/main) may not reach out/main's siblings.
//
// Scoped to ../preload and ../renderer deliberately. electron-vite's own
// `?asset` handling also emits parent-relative __dirname joins, but it computes
// the depth from where it emits the chunk, so those are correct by construction
// and matching them would be a false positive.
const PARENT_RELATIVE_DIRNAME = /__dirname\s*,\s*["'`]\.\.\/(preload|renderer)/

export function createMainOutputRelativePathGuardPlugin(): Plugin {
  return {
    name: 'orca-main-output-relative-path-guard',
    generateBundle(_options: unknown, bundle: OutputBundle) {
      for (const output of Object.values(bundle)) {
        const chunk = output as OutputChunk
        if (chunk.type !== 'chunk' || chunk.isEntry) {
          continue
        }
        const match = PARENT_RELATIVE_DIRNAME.exec(chunk.code)
        if (match) {
          this.error(
            `[main-output-relative-path-guard] chunk "${chunk.fileName}" resolves a ` +
              `parent-relative path from __dirname. Chunks live in out/main/chunks/, so ` +
              `__dirname is one level deeper than out/main and the path silently misses ` +
              `(the blank-window outage) — matched: ${JSON.stringify(chunk.code.slice(Math.max(0, (match.index ?? 0) - 90), (match.index ?? 0) + 60))}. Use outMainDirectory() from ` +
              `src/main/out-main-directory.ts instead.`
          )
        }
      }
    }
  }
}
