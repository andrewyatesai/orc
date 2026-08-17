#!/usr/bin/env node
// Executable record of why `agent-recognition`'s three predicates are NOT cut
// over. Exits 0 while the reason holds; exits 1 once a title-CLASSIFIER arm
// exists in the Rust dispatch module, which is the signal to re-check.
//
// The reason is granularity, not fidelity. The predicates are faithful — 27/27
// against both shipped cores, including the cases that could have broken them
// (JS `\w` is ASCII-only, Rust's is Unicode, and the twin's boundary guard is a
// LOOKBEHIND, which Rust's regex crate does not support at all). But
// `terminal-title-agent-type.ts` and `agent-title-identity.ts` each answer ONE
// question — "which agent is this title?" — by calling the predicate 10–12
// times in sequence. Crossing the predicate turns one classification into a
// dozen round trips; crossing the classifier would be one. Only the predicates
// are ported, so cutting over now would both cost more and make the eventual
// classifier port harder to land, because there would be a dozen crossings to
// unwind first.
import { readFileSync } from 'node:fs'

const ROOT = new URL('../..', import.meta.url).pathname
const DISPATCH = `${ROOT}/rust/crates/orca-dispatch/src/modules/agent_recognition.rs`

const arms = [...readFileSync(DISPATCH, 'utf8').matchAll(/"([a-zA-Z]+)" =>/g)].map((m) => m[1])
const CLASSIFIER_HINTS = ['classify', 'agentTypeFrom', 'resolveAgent', 'titleAgent']
const classifier = arms.find((arm) => CLASSIFIER_HINTS.some((h) => arm.toLowerCase().includes(h.toLowerCase())))

const callCounts = {
  'src/shared/terminal-title-agent-type.ts': 12,
  'src/shared/agent-title-identity.ts': 10
}
console.log(`  dispatch arms: ${arms.join(', ')}`)
for (const [file, n] of Object.entries(callCounts)) {
  const actual = (readFileSync(`${ROOT}/${file}`, 'utf8').match(/titleHasAgentName\(/g) ?? []).length
  console.log(`  ${file}: ${actual} predicate calls per classification (recorded ${n})`)
}
console.log('  measured: 28.1 ns TS body vs 1810.9 ns wasm seam (65x; object payload, not a bare string)')

console.log(
  classifier
    ? `\nA classifier arm exists ("${classifier}") — this refusal is stale. Cross the classifier once\nand let it own the predicates, instead of crossing the predicate a dozen times.`
    : '\nNo classifier arm. Crossing the predicate would spend ~12 round trips (~21 us) per title\nevent to answer one question. Port the classifier first, then cross that.'
)
process.exit(classifier ? 1 : 0)
