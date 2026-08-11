// What a site id has to survive, and what it has to notice.
//
// The previous id ended in an ordinal — the position of the call among
// identical siblings — and that is what broke: adding a write ABOVE a reviewed
// one re-keyed it, the carried review matched nothing, and the site it judged
// came back as `unreviewed` on an edit that never touched it. Twice.
//
// These are tests of the JOIN KEY, not of the detector. They drive the real
// identity code over synthetic sources whose right answer is obvious.

import { expect, it } from 'vitest'

import ts from 'typescript-api'

import { assignSiteIds, enclosingDeclarationPath } from './credential-write-site-identity.mjs'
import { callShape } from './credential-write-call-shape.mjs'
import { createInMemoryProject } from './typescript-symbol-resolution.mjs'

/** One fixture sink, so the sink half of the id is fixed and only identity moves. */
const SINK = { kind: 'fs', origin: 'fs', name: 'writeFileSync' }

function callsIn(sourceFile) {
  const calls = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return calls.sort((a, b) => a.getStart() - b.getStart())
}

/** Every call in `source`, in source order, through the real identity pipeline. */
function idsFor(source, fileName = 'subject.ts') {
  const project = createInMemoryProject({ [fileName]: source })
  const sites = callsIn(project.sourceFile(fileName)).map((call) => ({
    call,
    sink: SINK
  }))
  return assignSiteIds(sites).map((site) => ({
    text: site.call.getText().replace(/\s+/g, ' '),
    id: site.idSource,
    scope: site.scope,
    shape: site.shape
  }))
}

const withText = (sites, text) => sites.find((site) => site.text === text)

const ORIGINAL = `import { writeFileSync } from 'node:fs'
export function save(path: string, apiToken: string): void {
  writeFileSync(path, apiToken, { mode: 0o600 })
}
`

it('a write inserted ABOVE a reviewed one leaves its id alone', () => {
  const inserted = `import { writeFileSync } from 'node:fs'
export function save(path: string, apiToken: string): void {
  writeFileSync(path, 'audit: about to persist', { mode: 0o644 })
  writeFileSync(path, apiToken, { mode: 0o600 })
}
`
  const before = idsFor(ORIGINAL)
  const after = idsFor(inserted)
  const call = 'writeFileSync(path, apiToken, { mode: 0o600 })'

  // The whole point: the reviewed write did not move in any way that matters,
  // so the note keyed to it must still find it.
  expect(withText(after, call).id).toBe(withText(before, call).id)
  expect(after).toHaveLength(2)
})

it('renaming a local, reformatting and moving the call down change nothing', () => {
  const edited = `import { writeFileSync } from 'node:fs'

export function save(destination: string, secretValue: string): void {
  // a comment, and some breathing room
  const unrelated = destination.length
  void unrelated

  writeFileSync(
    destination,
    secretValue,
    { mode: 0o600 }
  )
}
`
  expect(idsFor(edited).at(-1).id).toBe(idsFor(ORIGINAL)[0].id)
})

it('a call held in a variable is scoped to its function, not to the variable', () => {
  // `const written = write(...)` used to read as scope `save.written`, so wrapping a
  // call in a variable — a refactor that changes no write — detached its review.
  const source = `import { writeFileSync } from 'node:fs'
export function save(path: string, apiToken: string): unknown {
  const written = writeFileSync(path, apiToken, { mode: 0o600 })
  return written
}
`
  expect(idsFor(source)[0].scope).toBe('save')
})

it('an arrow function still takes the name of the const holding it', () => {
  const source = `import { writeFileSync } from 'node:fs'
export const save = (path: string, apiToken: string): void => {
  writeFileSync(path, apiToken, { mode: 0o600 })
}
`
  expect(idsFor(source)[0].scope).toBe('save')
})

it('sibling writes through one sink in one function get different ids', () => {
  const source = `import { writeFileSync } from 'node:fs'
export function save(path: string, apiToken: string, ciphertext: Buffer): void {
  writeFileSync(path, ciphertext, { mode: 0o600 })
  writeFileSync(path + '.plaintext', apiToken, { encoding: 'utf8', mode: 0o600 })
}
`
  const ids = idsFor(source).map((site) => site.id)
  expect(new Set(ids).size).toBe(2)
})

it('twins with the same shape AND the same literals are marked as ordinal-identified', () => {
  // The residual, made visible rather than hidden: nothing distinguishes these
  // two calls but their order, and the `~1` says so.
  const source = `import { writeFileSync } from 'node:fs'
export function save(path: string, apiToken: string): void {
  writeFileSync(path, apiToken, { mode: 0o600 })
  writeFileSync(path, apiToken, { mode: 0o600 })
}
`
  const ids = idsFor(source).map((site) => site.id)
  expect(ids[0]).not.toMatch(/~\d+$/)
  expect(ids[1]).toBe(`${ids[0]}~1`)
})

it('the shape names the payload, not the identifiers it happens to use', () => {
  const project = createInMemoryProject({
    'shape.ts': `declare function write(a: unknown, b: unknown): void
export function one(token: string) { write({ v: 2, secretKeyFormat: 'plaintext' }, token) }
export function two(other: string) { write({ secretKeyFormat: 'plaintext', v: 2 }, other) }
export function three(other: string) { write({ v: 2, secretKeyFormat: 'sealed' }, other) }
`
  })
  const [one, two, three] = callsIn(project.sourceFile('shape.ts')).map(callShape)
  // Key order and the argument's local name are noise; the format written is not.
  expect(two).toBe(one)
  expect(three).not.toBe(one)
})

it('enclosingDeclarationPath keeps class and method names', () => {
  const project = createInMemoryProject({
    'klass.ts': `declare function write(a: unknown): void
export class Store {
  save(token: string) { write(token) }
}
`
  })
  const call = callsIn(project.sourceFile('klass.ts'))[0]
  expect(enclosingDeclarationPath(call)).toBe('Store.save')
})
