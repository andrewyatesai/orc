// TS dispatch for the quick-open-rank parity module. The TS ranking was
// DELETED (the Rust orca-text index is the sole impl — the renderer drives it
// via a prepared wasm QuickOpenIndex), so this adapter drives the same wasm:
// the vectors' recorded goldens now pin that surface absolutely. The vector
// passes RAW paths; the index prepares them at construction, exactly as the
// renderer does.
import { gitWasmOracle } from './orca-git-wasm-oracle'

const QUICK_OPEN_RESULT_LIMIT = 50

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'rankQuickOpenFiles': {
      const { query, paths, limit } = input as {
        query: string
        paths: string[]
        limit?: number
      }
      const index = new (gitWasmOracle().QuickOpenIndex)(paths.join('\0'))
      // Flat [inputIndex, score, …]; the vector owns the path list, so the
      // goldens are reconstructed here exactly as the renderer does.
      const ranked = index.rankIndices(query, limit ?? QUICK_OPEN_RESULT_LIMIT)
      const results: { path: string; score: number }[] = []
      for (let i = 0; i + 1 < ranked.length; i += 2) {
        const path = paths[ranked[i]!]
        if (path !== undefined) {
          results.push({ path, score: ranked[i + 1]! })
        }
      }
      return results
    }
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
