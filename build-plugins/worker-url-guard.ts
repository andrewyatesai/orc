// Rolldown-vite exposes Rollup's types through the vite package; importing from
// 'rollup' directly would resolve a different, non-installed implementation.
import type { Plugin, Rollup } from 'vite'

type NormalizedOutputOptions = Rollup.NormalizedOutputOptions
type OutputBundle = Rollup.OutputBundle
type OutputChunk = Rollup.OutputChunk

// Why: `new Worker(new URL('./x.ts', import.meta.url))` is the documented Vite
// form, but rolldown-vite silently collapses it to the DOCUMENT url — under the
// orca://app scheme that is index.html, so the worker never loads. The aterm
// shared render worker is on by default, and its failure only degrades to the
// in-process engine, so no test goes red. Assert the emitted shape instead:
// every worker construction must name a real emitted asset.
const DOCUMENT_URL_WORKER_RE = /new Worker\(\s*(self\.)?location\.href/
const WORKER_ASSET_RE = /new Worker\(\s*""\s*\+\s*new URL\(\s*"([^"]+)"/g

export function createWorkerUrlGuardPlugin(): Plugin {
  return {
    name: 'orca-worker-url-guard',
    generateBundle(_options: NormalizedOutputOptions, bundle: OutputBundle) {
      const problems: string[] = []
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') {
          continue
        }
        const chunk = item as OutputChunk
        if (DOCUMENT_URL_WORKER_RE.test(chunk.code)) {
          problems.push(
            `${chunk.fileName} constructs a Worker from the document URL; the bundler failed to ` +
              'resolve a worker entry (use the `?worker` import form)'
          )
        }
        for (const match of chunk.code.matchAll(WORKER_ASSET_RE)) {
          const asset = match[1]
          const emitted = Object.keys(bundle).some((name) => name.endsWith(asset))
          if (!emitted) {
            problems.push(`${chunk.fileName} references worker asset "${asset}", which was not emitted`)
          }
        }
      }
      if (problems.length > 0) {
        this.error(`[worker-url-guard] worker loading would fail at runtime:\n  - ${problems.join('\n  - ')}`)
      }
    }
  }
}
