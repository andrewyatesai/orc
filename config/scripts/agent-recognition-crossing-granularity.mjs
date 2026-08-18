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

// The refusal's claim is narrow and checkable: ONLY these three predicates are
// routed, so no classifier exists to cross instead. Assert the exact set rather
// than sniffing for classifier-ish NAMES — the first version of this check
// matched four guessed substrings, which a port naming its arm
// `agentTypeForTitle` or `detectAgent` would have walked straight past, leaving
// the census asserting a refusal that had already stopped being true. A tripwire
// that can silently miss is worse than no tripwire, because it reads as coverage.
const RECORDED_ARMS = ['titleHasAgentName', 'titleHasAnyLegacyAgentName', 'isExpectedAgentProcess']
const added = arms.filter((arm) => !RECORDED_ARMS.includes(arm))
const removed = RECORDED_ARMS.filter((arm) => !arms.includes(arm))
const changed = added.length > 0 || removed.length > 0

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

if (changed) {
  console.log('\nThe routed arm set has CHANGED — this refusal is stale, re-check the module.')
  if (added.length > 0) {
    console.log(`  added:   ${added.join(', ')}`)
    console.log('  If one of those is a title classifier, cross IT once and let it own the')
    console.log('  predicates, instead of crossing the predicate a dozen times.')
  }
  if (removed.length > 0) {
    console.log(`  removed: ${removed.join(', ')}`)
  }
  process.exit(1)
}
console.log('\nOnly the three predicates are routed. Crossing one would spend ~12 round trips')
console.log('(~21 us) per title event to answer one question. Port the classifier first.')
