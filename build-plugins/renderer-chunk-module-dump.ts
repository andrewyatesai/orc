import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'rollup'

// Why: when the renderer chunk-budget ratchet fails, the offender is a MODULE,
// not a chunk — set ORCA_DUMP_CHUNK_MODULES=<dir> to write per-module byte
// attribution (renderer-chunk-modules.json) and find what grew or went eager.
export function createChunkModuleDumpPlugin(): Plugin {
  return {
    name: 'orca-chunk-module-dump',
    generateBundle(_options, bundle) {
      const outDir = process.env.ORCA_DUMP_CHUNK_MODULES
      if (!outDir) {
        return
      }
      const dump: Record<string, unknown> = {}
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') {
          continue
        }
        dump[chunk.fileName] = {
          isEntry: chunk.isEntry,
          imports: chunk.imports,
          modules: Object.fromEntries(
            Object.entries(chunk.modules).map(([id, m]) => [id, m.renderedLength])
          )
        }
      }
      writeFileSync(resolve(outDir, 'renderer-chunk-modules.json'), JSON.stringify(dump))
    }
  }
}
