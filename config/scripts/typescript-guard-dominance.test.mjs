// Attack 8 and its neighbours: a predicate call that merely EXISTS in the file
// must not count as a guard. Each row states the ground truth and, where the
// analysis deliberately under-approximates, says so.

import { describe, expect, it } from 'vitest'

import ts from 'typescript-api'

import {
  createInMemoryProject,
  DOMINANCE_CONTRACT,
  dominatingNodes,
  enclosingFunction,
  evaluationDominates,
  findDominatingCall
} from './typescript-symbol-resolution.mjs'

const PRELUDE = `declare function P(): boolean
declare function O(): void
declare function later(cb: () => void): void
declare const maybe: undefined | { go(n: number): void }
declare function take(a: unknown, b: unknown): void
`

/** true  = the analysis reports "O is guarded by P"
 *  false = it does not. GUARDED rows are facts; NOT-GUARDED rows are either
 *  facts or the documented conservative direction, flagged in the name. */
const CASES = [
  ['straight line', `function f() { P(); O() }`, true],
  ['early-return guard', `function f() { if (!P()) { return }; O() }`, true],
  ['early-throw guard', `function f() { if (!P()) { throw new Error('x') }; O() }`, true],
  ['then-branch of the guard', `function f() { if (P()) { O() } }`, true],
  ['nested plain block', `function f() { { P() }; O() }`, true],
  ['awaited guard', `async function f() { await P(); O() }`, true],
  ['left of &&', `function f() { const x = P() && (O(), true); void x }`, true],
  ['ternary condition', `function f() { const x = P() ? 1 : 0; void x; O() }`, true],
  ['earlier call argument', `function f() { take(P(), O()) }`, true],
  ['do-while body runs once', `function f(c: boolean) { do { P() } while (c); O() }`, true],
  ['finally always runs', `function f() { try { } finally { P() }; O() }`, true],
  ['try without catch', `function f() { try { P() } finally { }; O() }`, true],
  [
    'inside the same loop body',
    `function f(n: number) { for (let i = 0; i < n; i++) { P(); O() } }`,
    true
  ],
  [
    'loop initializer',
    `function f(n: number) { for (let i = P() ? 0 : 1; i < n; i++) { O() } }`,
    true
  ],
  ['class method early return', `class C { m() { if (!P()) { return }; O() } }`, true],
  ['module top level', `P(); O()`, true],

  ['ATTACK 8: dead branch', `function f() { if (false) { P() }; O() }`, false],
  ['ATTACK 8: sibling if', `function f(c: boolean) { if (c) { P() }; O() }`, false],
  ['ATTACK 8: else branch only', `function f(c: boolean) { if (c) { P() } else { O() } }`, false],
  [
    'ATTACK 8: loop body may not run',
    `function f(n: number) { for (let i = 0; i < n; i++) { P() }; O() }`,
    false
  ],
  ['ATTACK 8: while body may not run', `function f(c: boolean) { while (c) { P() }; O() }`, false],
  [
    'ATTACK 8: switch case',
    `function f(n: number) { switch (n) { case 1: P(); break }; O() }`,
    false
  ],
  ['ATTACK 8: deferred callback', `function f() { later(() => { P() }); O() }`, false],
  ['ATTACK 8: right of &&', `function f(c: boolean) { const x = c && P(); void x; O() }`, false],
  [
    'ATTACK 8: ternary branch',
    `function f(c: boolean) { const x = c ? P() : false; void x; O() }`,
    false
  ],
  ['ATTACK 8: after the call', `function f() { O(); P() }`, false],
  [
    'ATTACK 8: labeled break skips it',
    `function f(c: boolean) { outer: { if (c) { break outer }; P() }; O() }`,
    false
  ],
  ['ATTACK 8: optional-chain argument', `function f() { maybe?.go(P() ? 1 : 0); O() }`, false],
  [
    'CONSERVATIVE: guard in another function',
    `function g() { P() }\nfunction f() { g(); O() }`,
    false
  ],
  ['CONSERVATIVE: try body with a catch', `function f() { try { P() } catch { }; O() }`, false]
]

const files = {}
for (const [name, body] of CASES) {
  files[`${name.replace(/[^a-z0-9]+/gi, '-')}.ts`] = `${PRELUDE}${body}\n`
}
const project = createInMemoryProject(files)

function callTo(name) {
  return (call) => ts.isIdentifier(call.expression) && call.expression.text === name
}

function lastCallTo(sourceFile, name) {
  let found
  const walk = (node) => {
    if (ts.isCallExpression(node) && callTo(name)(node)) {
      found = node
    }
    ts.forEachChild(node, walk)
  }
  walk(sourceFile)
  return found
}

describe('dominance, not reachability', () => {
  for (const [name, , guarded] of CASES) {
    it(`${guarded ? 'GUARDED' : 'not guarded'}: ${name}`, () => {
      const sourceFile = project.sourceFile(`${name.replace(/[^a-z0-9]+/gi, '-')}.ts`)
      const operation = lastCallTo(sourceFile, 'O')
      expect(operation, 'fixture must contain a call to O').toBeDefined()
      expect(Boolean(findDominatingCall(operation, callTo('P')))).toBe(guarded)
    })
  }
})

describe('dominance primitives', () => {
  const shape = createInMemoryProject({
    'shape.ts': `${PRELUDE}function f() {
  P()
  O()
}
const arrow = () => { O() }
void arrow
`
  })
  const sourceFile = shape.sourceFile('shape.ts')

  it('never reports a node as dominating itself', () => {
    const operation = lastCallTo(sourceFile, 'O')
    expect(evaluationDominates(operation, operation)).toBe(false)
  })

  it('never reports an enclosing expression as a dominator', () => {
    const operation = lastCallTo(sourceFile, 'O')
    expect(dominatingNodes(operation)).not.toContain(operation.parent)
  })

  it('stops at the enclosing function', () => {
    const operation = lastCallTo(sourceFile, 'O')
    const owner = enclosingFunction(operation)
    expect(ts.isArrowFunction(owner)).toBe(true)
    expect(dominatingNodes(operation)).toHaveLength(0)
  })

  it('publishes the approximation it makes', () => {
    expect(DOMINANCE_CONTRACT).toMatch(/under-approximation/)
    expect(DOMINANCE_CONTRACT).toMatch(/try-with-catch/)
  })
})

describe('an unmodelled construct denies rather than assumes', () => {
  // Deny-by-default is the whole soundness argument: a node kind the analysis
  // does not understand yields no dominators, so the gate reports a violation.
  const exotic = createInMemoryProject({
    'exotic.ts': `${PRELUDE}function f(items: number[]) {
  const [x = (P() ? 1 : 2)] = items
  void x
  O()
}
`
  })

  it('a call buried in a destructuring default is not treated as a guard', () => {
    const operation = lastCallTo(exotic.sourceFile('exotic.ts'), 'O')
    expect(findDominatingCall(operation, callTo('P'))).toBeUndefined()
  })
})
