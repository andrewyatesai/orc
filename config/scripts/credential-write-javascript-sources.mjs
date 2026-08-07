// The analysed directories are not all TypeScript.
//
// `src/relay/wasm/orca_git_wasm.js`, `src/shared/crypto-wasm/orca_crypto_wasm.js`
// and three `__fixtures__/*.mjs` live under src/main, src/relay and src/shared —
// inside the directories this report covers — and no tsconfig lists them. An
// earlier coverage check only looked for `.ts`/`.tsx`, so those files were in no
// Program and nothing said so. Generated wasm glue calling `require('fs')` is
// exactly the shape that slips through such a hole.
//
// So they get their own Program instead of an exemption: a synthetic allowJs
// project rooted at exactly those files, analysed by the same sink model and the
// same secrecy detector. It is small (single digits of files), so it runs with
// no reachability filter at all.

import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript-api'

import { REPO_ROOT, displayPath, normalizeProgramPath } from './typescript-program-cache.mjs'

export const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.git', '__snapshots__'])

/** Every JavaScript source on disk under the analysed directories. No filename
 *  convention excludes anything: a fixture that writes a credential writes it. */
export function javascriptSourcesIn(analysedDirs) {
  const found = []
  for (const dir of analysedDirs) {
    const stack = [path.join(REPO_ROOT, dir)]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!fs.existsSync(current)) {
        continue
      }
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name)
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            stack.push(child)
          }
        } else if (JAVASCRIPT_EXTENSIONS.has(path.extname(entry.name))) {
          found.push(child)
        }
      }
    }
  }
  return found.sort()
}

/** A Program over those files with allowJs on and node's types available, so
 *  `require('fs')` resolves to the same `fs` declarations the TypeScript
 *  projects use and a write is the same declaration identity in both. */
export function javascriptProject(roots) {
  if (roots.length === 0) {
    return undefined
  }
  const options = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    resolveJsonModule: true,
    types: ['node']
  }
  const resolutionCache = ts.createModuleResolutionCache(
    REPO_ROOT,
    (fileName) => normalizeProgramPath(fileName),
    options
  )
  const program = ts.createProgram({ rootNames: roots, options })
  const scan = {
    id: 'analysed-javascript',
    tsconfigPath: null,
    options,
    fileNames: roots,
    fileKeys: new Set(roots.map(normalizeProgramPath)),
    resolveModule(specifier, containingFile) {
      const resolved = ts.resolveModuleName(
        specifier,
        containingFile,
        options,
        ts.sys,
        resolutionCache
      )
      const fileName = resolved.resolvedModule?.resolvedFileName
      return fileName ? { key: normalizeProgramPath(fileName), path: fileName } : undefined
    }
  }
  return {
    id: 'analysed-javascript',
    kind: 'javascript',
    scan,
    tsconfigPath: null,
    program,
    checker: program.getTypeChecker(),
    rootFiles: roots,
    displayRoots: roots.map(displayPath)
  }
}
