#!/usr/bin/env node
// Cost of the safe dispatch encoder against bare JSON.stringify.
//
// This sits on the hot path of EVERY Rust call, so the overhead is a number we
// keep, not a claim: `node config/scripts/dispatch-payload-codec-benchmark.mjs`.
// `--check` fails when the safe encoder regresses past the budget below, or when
// the all-numeric fast path stops being materially cheaper than the safe walk
// (the reason that fast path exists — see keep-tail, whose `update` runs on every
// pending-data change).
import { hrtime } from 'node:process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Why bundle instead of importing the .ts: node's type stripping does not resolve
// the repo's extensionless relative imports, and bundling measures the shape the
// app actually ships (electron-vite/esbuild output), not a loader's.
const bundle = await build({
  entryPoints: [
    fileURLToPath(new URL('../../src/shared/dispatch-payload-codec.ts', import.meta.url))
  ],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false
})
const { encodeDispatchPayload, encodeNumericDispatchPayload } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

// Budgets are ratios against bare JSON.stringify on the same payload, measured on
// the payload shapes the ported modules actually send. Generous vs the observed
// numbers so this fails on a design regression, not on a noisy laptop.
const CASES = [
  {
    name: 'keep-tail {droppableSessions:n}',
    payload: { droppableSessions: 7 },
    numeric: true,
    // A ~26 ns baseline is all fixed cost, so the ratio is the least meaningful
    // here and the absolute delta (~50 ns/call) is the number that matters.
    maxSafeRatio: 4.0,
    iterations: 200_000
  },
  {
    name: 'scalar string argument',
    payload: 'is:open repo:andrewyatesai/orca-alab author:@me',
    maxSafeRatio: 2.0,
    iterations: 200_000
  },
  {
    name: 'task-claim {agentId, claimedAt, filesModified[30]}',
    payload: {
      agentId: 'agent-4f2c',
      claimedAt: 1_756_000_000_000,
      filesModified: Array.from({ length: 30 }, (_, i) => `src/shared/module-${i}/index.ts`)
    },
    maxSafeRatio: 2.0,
    iterations: 100_000
  },
  {
    name: 'wide list payload (200 rows)',
    payload: {
      rows: Array.from({ length: 200 }, (_, i) => ({
        id: `row-${i}`,
        title: `Some title ${i}`,
        count: i,
        flag: i % 2 === 0,
        nested: { a: `x${i}`, b: null }
      }))
    },
    maxSafeRatio: 2.5,
    iterations: 20_000
  },
  {
    name: 'astral text (emoji, the surrogate control)',
    payload: { title: '🚀 ship it', body: '🎉'.repeat(200) },
    maxSafeRatio: 2.0,
    iterations: 100_000
  }
]

function nanosPerCall(fn, payload, iterations) {
  for (let i = 0; i < 5_000; i++) {
    fn(payload)
  }
  const start = hrtime.bigint()
  for (let i = 0; i < iterations; i++) {
    fn(payload)
  }
  return Number(hrtime.bigint() - start) / iterations
}

const check = process.argv.includes('--check')
const failures = []

console.log('payload'.padEnd(52), 'JSON.stringify'.padStart(15), 'encode'.padStart(12), 'ratio')
for (const testCase of CASES) {
  const { name, payload, iterations } = testCase
  const bare = nanosPerCall(JSON.stringify, payload, iterations)
  const safe = nanosPerCall(encodeDispatchPayload, payload, iterations)
  const ratio = safe / bare
  const columns = [
    name.padEnd(52),
    `${bare.toFixed(0)} ns`.padStart(15),
    `${safe.toFixed(0)} ns`.padStart(12),
    `${ratio.toFixed(2)}x (+${(safe - bare).toFixed(0)} ns)`
  ]
  if (testCase.numeric) {
    const fast = nanosPerCall(encodeNumericDispatchPayload, payload, iterations)
    columns.push(`| fast path ${fast.toFixed(0)} ns = ${(fast / bare).toFixed(2)}x bare`)
    if (check && fast > safe) {
      failures.push(
        `${name}: the numeric fast path (${fast.toFixed(0)} ns) is not cheaper than the safe encoder (${safe.toFixed(0)} ns)`
      )
    }
  }
  console.log(columns.join(' '))
  if (check && ratio > testCase.maxSafeRatio) {
    failures.push(
      `${name}: ${ratio.toFixed(2)}x bare JSON.stringify exceeds the ${testCase.maxSafeRatio}x budget`
    )
  }
}

if (failures.length > 0) {
  console.error(`\nencoder overhead regressed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
