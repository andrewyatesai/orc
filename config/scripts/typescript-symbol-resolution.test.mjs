// Nine of the ten attacks that defeated the previous regex-based gates, run
// against the semantic primitive. Attack 8 (a guard call that does not dominate
// the operation) is a control-flow question and lives in
// typescript-guard-dominance.test.mjs instead.
//
// Only the `it`s that name an attack replay one; the rest cover the primitive's
// own contract (identity, erasure, coverage).

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import ts from 'typescript-api'

import {
  callSiteFacts,
  constantStringArgument,
  createInMemoryProject,
  createSymbolTarget,
  findTargetCallSites,
  findTargetReferences,
  importBindingIsErased,
  literalStringArgument,
  REPO_ROOT,
  resolveReference,
  runtimeAliasEscapes,
  uncoveredSourceFiles
} from './typescript-symbol-resolution.mjs'

const SEAM = `export function writeFileAtomically(target: string, data: string): void {
  void target
  void data
}
export type WriteOptions = { mode: number }
`

/** One fixture project shared by the attack cases; every attacker file lives
 *  beside the same seam module. */
function attackProject(extra) {
  return createInMemoryProject({ 'seam.ts': SEAM, ...extra })
}

function target(project) {
  return createSymbolTarget(project, {
    moduleFile: project.resolve('seam.ts'),
    exportName: 'writeFileAtomically'
  })
}

function callFilesIn(project) {
  return findTargetCallSites(project, target(project), { files: null })
    .map((hit) => hit.sourceFile.fileName.split('/').pop())
    .sort()
}

function referenceFilesIn(project) {
  return [
    ...new Set(
      findTargetReferences(project, target(project), { files: null }).map((hit) =>
        hit.sourceFile.fileName.split('/').pop()
      )
    )
  ].sort()
}

function firstCall(project, relative, calleeText) {
  const sourceFile = project.sourceFile(relative)
  let found
  const walk = (node) => {
    if (!found && ts.isCallExpression(node) && node.expression.getText() === calleeText) {
      found = node
    }
    ts.forEachChild(node, walk)
  }
  walk(sourceFile)
  return found
}

describe('forged text cannot forge a symbol (attacks 1-4)', () => {
  const project = attackProject({
    'comment.ts': `// writeFileAtomically('a', 'b')\n/* import { writeFileAtomically } from './seam' */\nexport const comment = 1\n`,
    'string.ts': `export const s = "writeFileAtomically('a','b')"\n`,
    'template.ts': `export const t = \`import { writeFileAtomically } from './seam'\`\n`,
    'regex.ts': `export const r = /writeFileAtomically\\('a'\\)/g\n`
  })

  it('attack 1: a magic string in a comment resolves to nothing', () => {
    expect(referenceFilesIn(project)).not.toContain('comment.ts')
  })

  it('attack 2: a string literal resolves to nothing', () => {
    expect(referenceFilesIn(project)).not.toContain('string.ts')
  })

  it('attack 3: a template literal resolves to nothing', () => {
    expect(referenceFilesIn(project)).not.toContain('template.ts')
  })

  it('attack 4: a regex literal resolves to nothing', () => {
    expect(referenceFilesIn(project)).not.toContain('regex.ts')
  })

  it('finds only the declaration itself when nobody imports the seam', () => {
    expect(referenceFilesIn(project)).toEqual(['seam.ts'])
    expect(callFilesIn(project)).toEqual([])
  })
})

describe('renaming, laundering and namespaces do not hide a call (attacks 5, 10)', () => {
  const project = attackProject({
    'barrel.ts': `export { writeFileAtomically } from './seam'\n`,
    'star-barrel.ts': `export * from './seam'\n`,
    'local-reexport.ts': `import { writeFileAtomically } from './seam'\nexport { writeFileAtomically }\n`,
    'renamed.ts': `import { writeFileAtomically as w } from './seam'\nexport function go() { w('p', 'd') }\n`,
    'laundered.ts': `import { writeFileAtomically } from './barrel'\nexport function go() { writeFileAtomically('p', 'd') }\n`,
    'star-laundered.ts': `import { writeFileAtomically as z } from './star-barrel'\nexport function go() { z('p', 'd') }\n`,
    'double-laundered.ts': `import { writeFileAtomically as q } from './local-reexport'\nexport function go() { q('p', 'd') }\n`,
    'namespace.ts': `import * as seam from './seam'\nexport function go() { seam.writeFileAtomically('p', 'd') }\n`,
    'computed.ts': `import * as seam from './seam'\nexport function go() { seam['writeFileAtomically']('p', 'd') }\n`,
    'jsx-forgery.tsx': `export function C() {\n  return <div>{"import { writeFileAtomically } from './seam'"}</div>\n}\n`
  })

  it('attack 5: a renamed import is still the seam symbol', () => {
    expect(callFilesIn(project)).toContain('renamed.ts')
  })

  it('re-export laundering, star re-export and local re-export all resolve back', () => {
    expect(callFilesIn(project)).toEqual(
      expect.arrayContaining([
        'computed.ts',
        'double-laundered.ts',
        'laundered.ts',
        'namespace.ts',
        'star-laundered.ts'
      ])
    )
  })

  it('attack 10: a JSX text node forging a named import creates no reference', () => {
    expect(referenceFilesIn(project)).not.toContain('jsx-forgery.tsx')
  })

  it('reports the callee module by declaration, not by callee text', () => {
    const facts = callSiteFacts(project, firstCall(project, 'renamed.ts', 'w'))
    expect(facts.calleeText).toBe('w')
    expect(facts.declaringModule).toMatch(/seam\.ts$/)
    expect(facts.isRuntimeCall).toBe(true)
  })
})

describe('type-only imports are not runtime doors (attack 6)', () => {
  const project = attackProject({
    'type-import.ts': `import type { writeFileAtomically } from './seam'\nexport type F = typeof writeFileAtomically\n`,
    'inline-type.ts': `import { type writeFileAtomically } from './seam'\nexport type G = typeof writeFileAtomically\n`,
    'type-reexport.ts': `export type { writeFileAtomically } from './seam'\n`,
    'annotation.ts': `import { writeFileAtomically } from './seam'\nexport const held: typeof writeFileAtomically | null = null\n`,
    'real.ts': `import { writeFileAtomically } from './seam'\nexport function go() { writeFileAtomically('p', 'd') }\n`
  })

  it('attack 6: `import type` is reported as erased, so no call site exists', () => {
    const erased = findTargetReferences(project, target(project), { files: null }).filter((hit) =>
      hit.sourceFile.fileName.endsWith('type-import.ts')
    )
    expect(erased.length).toBeGreaterThan(0)
    expect(erased.every((hit) => hit.reference.typeOnlyHop)).toBe(true)
    expect(erased.every((hit) => hit.reference.isRuntimeValueReference)).toBe(false)
    expect(callFilesIn(project)).not.toContain('type-import.ts')
  })

  it('inline `{ type X }` and `export type { X } from` are erased too', () => {
    for (const file of ['inline-type.ts', 'type-reexport.ts']) {
      const hits = findTargetReferences(project, target(project), { files: null }).filter((hit) =>
        hit.sourceFile.fileName.endsWith(file)
      )
      expect(hits.every((hit) => !hit.reference.isRuntimeValueReference)).toBe(true)
    }
  })

  it('a value-syntax import used only in type position is elided at runtime', () => {
    const bindingIn = (file) => {
      const clause = project.sourceFile(file).statements[0].importClause
      return clause.namedBindings.elements[0].name
    }
    expect(importBindingIsErased(project, bindingIn('annotation.ts'))).toBe(true)
    expect(importBindingIsErased(project, bindingIn('real.ts'))).toBe(false)
  })

  it('the genuine value import is still found', () => {
    expect(callFilesIn(project)).toEqual(['real.ts'])
  })
})

describe('a local shadow with the right name is not the seam (attack 7)', () => {
  const project = attackProject({
    'shadow.ts': `export function go() {
  const writeFileAtomically = (p: string, d: string): void => { void p; void d }
  writeFileAtomically('p', 'd')
}
`,
    'param-shadow.ts': `export function go(writeFileAtomically: (p: string, d: string) => void) {
  writeFileAtomically('p', 'd')
}
`,
    'import-shadow.ts': `import { writeFileAtomically } from './seam'
export function outer() {
  const writeFileAtomically = (p: string, d: string): void => { void p; void d }
  writeFileAtomically('p', 'd')
}
export function real() { writeFileAtomically('p', 'd') }
`
  })

  it('attack 7: a local const shadow resolves to the local declaration', () => {
    const call = firstCall(project, 'shadow.ts', 'writeFileAtomically')
    const reference = resolveReference(project, call.expression)
    expect(reference.declaringFiles.every((file) => file.endsWith('shadow.ts'))).toBe(true)
    expect(callFilesIn(project)).not.toContain('shadow.ts')
  })

  it('a parameter shadow is not the seam either', () => {
    expect(callFilesIn(project)).not.toContain('param-shadow.ts')
  })

  it('a shadow inside one function does not hide the real call in another', () => {
    const hits = findTargetCallSites(project, target(project), { files: null }).filter((hit) =>
      hit.sourceFile.fileName.endsWith('import-shadow.ts')
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].call.getText()).toBe("writeFileAtomically('p', 'd')")
    expect(hits[0].call.parent.parent.parent.name.text).toBe('real')
  })
})

describe('literal arguments are AST nodes, not substrings', () => {
  const project = attackProject({
    'args.ts': `import { writeFileAtomically } from './seam'
const KEY = 'from-const'
declare const runtime: string
export function go() {
  writeFileAtomically('literal', 'x')
  writeFileAtomically(KEY, 'x')
  writeFileAtomically(\`t-\${runtime}\`, 'x')
  writeFileAtomically('a' + 'b', 'x')
}
`
  })

  const calls = () =>
    findTargetCallSites(project, target(project), { files: null })
      .filter((hit) => hit.sourceFile.fileName.endsWith('args.ts'))
      .map((hit) => hit.call)

  it('a genuine string literal in argument position is read', () => {
    expect(literalStringArgument(calls()[0], 0)).toBe('literal')
  })

  it('a const-folded argument is NOT a literal but IS a constant', () => {
    expect(literalStringArgument(calls()[1], 0)).toBeUndefined()
    expect(constantStringArgument(project, calls()[1], 0)).toBe('from-const')
  })

  it('a template with substitutions and a concatenation are neither', () => {
    expect(literalStringArgument(calls()[2], 0)).toBeUndefined()
    expect(constantStringArgument(project, calls()[2], 0)).toBeUndefined()
    expect(literalStringArgument(calls()[3], 0)).toBeUndefined()
  })

  it('call-site facts flag exactly the genuine literal argument nodes', () => {
    expect(calls().map((call) => callSiteFacts(project, call).arguments[0].literal)).toEqual([
      true,
      false,
      false,
      false
    ])
  })
})

describe('documented non-goals behave honestly', () => {
  const project = attackProject({
    'indirect.ts': `import { writeFileAtomically } from './seam'
const held = writeFileAtomically
export function go() { held('p', 'd') }
`,
    'runtime-key.ts': `import * as seam from './seam'
declare const key: string
export function go() { (seam as unknown as Record<string, (a: string, b: string) => void>)[key]('p', 'd') }
`,
    'eval.ts': `export function go() {
  // eslint-disable-next-line no-eval
  return eval("writeFileAtomically('p','d')")
}
`
  })

  it('NON-GOAL: value indirection is reported as an escape, never as clean', () => {
    const escapes = runtimeAliasEscapes(project, target(project), { files: null })
    expect(escapes.map((hit) => hit.sourceFile.fileName.split('/').pop())).toContain('indirect.ts')
    // The `held('p','d')` call itself is invisible — that is exactly why a gate
    // must fail on a non-empty escape list.
    expect(callFilesIn(project)).not.toContain('indirect.ts')
  })

  it('NON-GOAL: a runtime-computed member key is invisible', () => {
    expect(callFilesIn(project)).not.toContain('runtime-key.ts')
    expect(referenceFilesIn(project)).not.toContain('runtime-key.ts')
  })

  it('NON-GOAL: eval is invisible and is not claimed otherwise', () => {
    expect(referenceFilesIn(project)).not.toContain('eval.ts')
  })
})

/** Every `X.tsx` under src that has a sibling `X.ts`. tsc's config file list
 *  keeps only one of an extension-colliding pair, so the .tsx is mechanically
 *  invisible to every Program — discovered here rather than named, so renaming
 *  the file that happens to collide today does not turn this suite red. */
function extensionShadowedFiles() {
  const shadowed = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
      } else if (entry.name.endsWith('.tsx') && fs.existsSync(absolute.slice(0, -1))) {
        shadowed.push(path.relative(REPO_ROOT, absolute).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(REPO_ROOT, 'src'))
  return shadowed.sort()
}

function topLevelSourceDirs() {
  return fs
    .readdirSync(path.join(REPO_ROOT, 'src'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `src/${entry.name}`)
    .sort()
}

describe('coverage is asserted, not assumed (attack 9)', () => {
  it('names every src file no project file list contains, and nothing else', () => {
    // A file dropped out of every tsconfig is invisible to the checker, which is
    // how a file-granular exemption gets smuggled in; the gate must see it.
    // Equality against the discovered extension-shadow set means a new blind
    // spot of any OTHER kind fails this test.
    //
    // WHAT THIS DOES NOT VERIFY: it does not stop someone deliberately creating
    // an extension-shadow pair to hide a .tsx from the checker — such a pair is
    // reported as expected, not as a violation.
    expect(uncoveredSourceFiles()).toEqual(extensionShadowedFiles())
  })

  it('reports coverage per directory and per project, not globally', () => {
    const dirs = topLevelSourceDirs()
    const covered = dirs.filter((dir) => uncoveredSourceFiles([dir], ['web']).length === 0)
    const uncovered = dirs.filter((dir) => uncoveredSourceFiles([dir], ['web']).length > 0)
    expect(dirs.length, 'src/ has no subdirectories to compare').toBeGreaterThan(0)
    expect(covered, 'no src/ directory is fully inside the web project').not.toEqual([])
    expect(uncovered, 'every src/ directory is inside the web project').not.toEqual([])
  })
})
