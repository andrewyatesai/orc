import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadRustGitBinding } from '../daemon/rust-git-addon'
import { activeFailureRefetchThrottleMs } from '../rust-provider-backoff'
import {
  ACTIVE_FAILURE_REFETCH_BASE_MS,
  MAX_ACTIVE_FAILURE_REFETCH_MS
} from './active-failure-backoff'

// Differential parity certificate (E1 unit): the production sizing now runs the
// Rust `orca-provider-backoff::active_failure_refetch_throttle_ms` through the
// napi seam, so this drives the SHIM over the SAME shared corpus the Rust unit
// test replays — it pins the seam (JSON hop, clamps, constants tie) rather than a
// second TS implementation. Paired with the ay proofs (that crate's
// proofs/ay/bo_*.smt2), this is the full E1 pair. The corpus encodes BASE=30000,
// MAX=900000 (mirroring MIN_POLL_MS / DEFAULT_POLL_MS).
const BASE_MS = ACTIVE_FAILURE_REFETCH_BASE_MS
const MAX_MS = MAX_ACTIVE_FAILURE_REFETCH_MS

// Skips cleanly when the .node is absent (CI without a native build).
const suite = loadRustGitBinding() ? describe : describe.skip

suite('active-failure refetch backoff shared parity corpus', () => {
  it('matches the Rust orca-provider-backoff corpus for every streak', () => {
    const corpusPath = fileURLToPath(
      new URL('../../../rust/crates/orca-provider-backoff/parity-corpus.txt', import.meta.url)
    )
    const corpus = readFileSync(corpusPath, 'utf8')
    let checked = 0
    let lineNo = 0
    for (const raw of corpus.split('\n')) {
      lineNo++
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) {
        continue
      }
      const [lhs, rhs = ''] = line.split('=>')
      const streak = Number(lhs.trim())
      const want = Number(rhs.trim())
      expect(
        activeFailureRefetchThrottleMs(streak, BASE_MS, MAX_MS),
        `throttle at streak=${streak} (line ${lineNo})`
      ).toBe(want)
      checked++
    }
    // Guard against a silently-empty corpus.
    expect(checked).toBeGreaterThanOrEqual(8)
  })

  it('doubles from the base and saturates at the ceiling', () => {
    expect(activeFailureRefetchThrottleMs(0, BASE_MS, MAX_MS)).toBe(30_000)
    expect(activeFailureRefetchThrottleMs(1, BASE_MS, MAX_MS)).toBe(30_000)
    expect(activeFailureRefetchThrottleMs(2, BASE_MS, MAX_MS)).toBe(60_000)
    expect(activeFailureRefetchThrottleMs(5, BASE_MS, MAX_MS)).toBe(480_000)
    // streak 6: 30000 * 32 = 960000 -> capped.
    expect(activeFailureRefetchThrottleMs(6, BASE_MS, MAX_MS)).toBe(900_000)
    expect(activeFailureRefetchThrottleMs(8, BASE_MS, MAX_MS)).toBe(900_000)
  })

  // The Rust core owns base/ceiling as constants; these pin the TS-side copies to
  // what the binary actually returns, so the two cannot drift into a silent throw.
  it('agrees with the Rust core on the base and ceiling constants', () => {
    expect(activeFailureRefetchThrottleMs(0, BASE_MS, MAX_MS)).toBe(ACTIVE_FAILURE_REFETCH_BASE_MS)
    expect(activeFailureRefetchThrottleMs(64, BASE_MS, MAX_MS)).toBe(MAX_ACTIVE_FAILURE_REFETCH_MS)
  })

  it('rejects bounds the Rust core cannot honor instead of ignoring them', () => {
    expect(() => activeFailureRefetchThrottleMs(3, 1_000, MAX_MS)).toThrow(
      /orca-provider-backoff core pins base=30000/
    )
    expect(() => activeFailureRefetchThrottleMs(3, BASE_MS, 60_000)).toThrow(/max=900000/)
  })

  // JSON.stringify turns NaN/Infinity into null (streak 0 on the Rust side), and
  // serde_json's as_i64 rejects a fractional number; the shim resolves all three
  // before the hop so none of them silently collapses to the base wait.
  it('normalizes non-integer and non-finite streaks across the JSON hop', () => {
    expect(activeFailureRefetchThrottleMs(Number.NaN, BASE_MS, MAX_MS)).toBe(30_000)
    expect(activeFailureRefetchThrottleMs(Number.POSITIVE_INFINITY, BASE_MS, MAX_MS)).toBe(900_000)
    expect(activeFailureRefetchThrottleMs(Number.NEGATIVE_INFINITY, BASE_MS, MAX_MS)).toBe(30_000)
    expect(activeFailureRefetchThrottleMs(-3, BASE_MS, MAX_MS)).toBe(30_000)
    // Truncated toward zero: a fractional failure count is not reachable, but it
    // must not read as streak 0 the way a raw float would.
    expect(activeFailureRefetchThrottleMs(2.5, BASE_MS, MAX_MS)).toBe(60_000)
  })
})
