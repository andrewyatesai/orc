// Rolldown-vite exposes Rollup's types through the vite package; importing from
// 'rollup' directly would resolve a different, non-installed implementation.
import type { Plugin, Rollup } from 'vite'

type NormalizedOutputOptions = Rollup.NormalizedOutputOptions
type OutputBundle = Rollup.OutputBundle
type OutputChunk = Rollup.OutputChunk

// Why: a sandboxed preload is loaded by Electron as ONE file from a literal
// path — it can neither resolve a relative chunk nor be found under a renamed
// extension. Both failures are silent: Electron logs a preload-error the app
// never surfaces, window.api stays undefined, and the only symptom is the
// renderer error boundary. The rolldown-vite migration produced exactly that
// (ESM `.mjs` entries plus a split-out `chunks/electron-*.js`), so the build
// asserts the contract instead of trusting bundler defaults.

// Entry name -> the literal path a main-process window passes as `preload`.
const PRELOAD_ENTRY_CONSUMERS: Readonly<Record<string, string>> = {
  index: 'src/main/window/createMainWindow.ts (../preload/index.js)',
  coordinator: 'src/main/coordinator-window.ts (../preload/coordinator.js)'
}

export function createPreloadBridgeGuardPlugin(): Plugin {
  return {
    name: 'orca-preload-bridge-guard',
    generateBundle(options: NormalizedOutputOptions, bundle: OutputBundle) {
      const chunks = Object.values(bundle).filter(
        (item): item is OutputChunk => item.type === 'chunk'
      )
      const problems: string[] = []

      // Why: the `.js` name alone is not the contract — an ESM module under a .js
      // name is equally unloadable as a sandboxed preload, and that is the half of
      // the original regression a filename check cannot see.
      if (options.format !== 'cjs') {
        problems.push(
          `preload build emits "${options.format}" modules; a sandboxed preload must be CommonJS`
        )
      }

      for (const [entryName, consumer] of Object.entries(PRELOAD_ENTRY_CONSUMERS)) {
        const entry = chunks.find((chunk) => chunk.isEntry && chunk.name === entryName)
        if (!entry) {
          problems.push(`preload entry "${entryName}" was not emitted; ${consumer} would load nothing`)
          continue
        }
        if (entry.fileName !== `${entryName}.js`) {
          problems.push(
            `preload entry "${entryName}" emitted as ${entry.fileName}, but ${consumer} loads ${entryName}.js`
          )
        }
        // Only emitted files matter: `imports` also lists externals such as
        // `electron`, which Electron resolves at runtime and are required.
        const chunkImports = [...entry.imports, ...entry.dynamicImports].filter(
          (imported) => bundle[imported] !== undefined
        )
        if (chunkImports.length > 0) {
          problems.push(
            `preload entry "${entry.fileName}" imports emitted chunk(s) ${chunkImports.join(', ')}; ` +
              'a sandboxed preload cannot load chunks, so every bundled dependency must be inlined ' +
              '(externalize runtime builtins like electron instead of bundling them)'
          )
        }
      }

      const sharedChunks = chunks.filter((chunk) => !chunk.isEntry)
      if (sharedChunks.length > 0) {
        problems.push(
          `preload build emitted non-entry chunk(s): ${sharedChunks.map((c) => c.fileName).join(', ')}`
        )
      }

      if (problems.length > 0) {
        this.error(
          `[preload-bridge-guard] the preload bridge would fail to load at runtime:\n  - ${problems.join('\n  - ')}`
        )
      }
    }
  }
}
