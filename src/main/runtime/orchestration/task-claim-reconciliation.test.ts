// The twin's suite, moved onto the seam shim: every case the deleted TS
// implementation pinned now runs against the Rust core, plus the cases the
// cut-over itself creates — the closed audit bypass, the four declared
// residuals, the input adapters, and the unbound seam.
//
// The seam is bound to the wasm core by config/vitest-orca-dispatch-seam.ts;
// the last suite re-runs the load-bearing rows through the napi binding main
// actually installs, because this module is main-only and napi is its only
// production path.
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeTaskClaimReconciliation,
  parseTaskClaim,
  reconcileTaskClaim,
  type TaskClaimInputs
} from './task-claim-reconciliation'
import { setOrcaDispatchBinding } from '../../../shared/orca-dispatch-seam'
import { orcaDispatch } from '../../../relay/wasm/orca_git_wasm.js'
import { loadRustGitBinding } from '../../daemon/rust-git-addon'

/** U+FFFD: what the core reads where the twin read an unpaired code unit. */
const REPAIRED = '�'

/** Rebind what the global setup installed, after a test clears it. */
function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

afterEach(bindWasm)

/** Off-type values reach these entries from an RPC payload and a SQLite row, so
 *  the adapter cases have to get past the declared types to be worth anything. */
function reconcileLoosely(args: unknown): unknown {
  return reconcileTaskClaim(args as TaskClaimInputs)
}

/** The claim an agent writes when one filename carries an unpaired surrogate.
 *  Built the way the lifecycle reconciler builds it, so the test cannot drift
 *  from the writer by a transcription slip. */
const SURROGATE_RESULT = JSON.stringify({
  completedBy: 'w\ud800',
  filesModified: ['src/a.ts', 'src/b.ts'],
  completedAt: 'now'
})

describe('reconcileTaskClaim', () => {
  const completed = (files: string[]) =>
    JSON.stringify({ completedBy: 'w1', filesModified: files, completedAt: 'now' })

  it('is the alert that can contradict an agent', () => {
    // The whole reason this exists: a task claiming work git cannot see.
    const result = reconcileTaskClaim({
      taskStatus: 'completed',
      result: completed(['src/a.ts', 'src/b.ts', 'src/c.ts']),
      changedFiles: []
    })
    expect(result).toMatchObject({
      verdict: 'mismatch',
      missing: ['src/a.ts', 'src/b.ts', 'src/c.ts']
    })
  })

  it('matches when the claim is true', () => {
    expect(
      reconcileTaskClaim({
        taskStatus: 'completed',
        result: completed(['src/a.ts']),
        changedFiles: ['src/a.ts']
      })
    ).toMatchObject({ verdict: 'match' })
  })

  it('normalizes path shape, so ./a.ts and a.ts are one file', () => {
    expect(
      reconcileTaskClaim({
        taskStatus: 'completed',
        result: completed(['./src/a.ts']),
        changedFiles: ['src/a.ts']
      })
    ).toMatchObject({ verdict: 'match' })
  })

  it('reports files changed but never claimed', () => {
    const result = reconcileTaskClaim({
      taskStatus: 'completed',
      result: completed(['src/a.ts']),
      changedFiles: ['src/a.ts', 'src/surprise.ts']
    })
    expect(result).toMatchObject({
      verdict: 'mismatch',
      unclaimed: ['src/surprise.ts'],
      missing: []
    })
  })

  it('degrades to unknown with no git — NEVER to mismatch', () => {
    // On a folder workspace an absent answer is not a discrepancy. Crying
    // mismatch here would train a supervisor to ignore the alert.
    const claim: TaskClaimInputs = {
      taskStatus: 'completed',
      result: completed(['src/a.ts']),
      changedFiles: null
    }
    expect(reconcileTaskClaim(claim)).toEqual({ verdict: 'unknown', reason: 'no-git' })
    expect(describeTaskClaimReconciliation(claim)).not.toContain('mismatch')
  })

  it.each([
    ['a task still running', 'dispatched', completed([])],
    ['an unreadable result', 'completed', 'not json'],
    ['no result at all', 'completed', null]
  ])('is unknown for %s', (_label, status, result) => {
    expect(reconcileTaskClaim({ taskStatus: status, result, changedFiles: [] }).verdict).toBe(
      'unknown'
    )
  })

  it('a completed task claiming nothing, with nothing changed, is a match not a mismatch', () => {
    expect(
      reconcileTaskClaim({ taskStatus: 'completed', result: completed([]), changedFiles: [] })
    ).toMatchObject({ verdict: 'match' })
  })
})

describe('parseTaskClaim', () => {
  it('drops non-string entries rather than trusting the shape', () => {
    const claim = parseTaskClaim(JSON.stringify({ filesModified: ['a.ts', 42, null] }))
    expect(claim?.filesModified).toEqual(['a.ts'])
  })

  it('returns null for anything unparseable', () => {
    expect(parseTaskClaim('nope')).toBeNull()
    expect(parseTaskClaim(null)).toBeNull()
    expect(parseTaskClaim('"a string"')).toBeNull()
  })
})

describe('describeTaskClaimReconciliation', () => {
  it.each([
    ['cannot check on a folder workspace', 'completed', '{"filesModified":["src/a.ts"]}', null],
    ['nothing to check yet', 'dispatched', '{"filesModified":["src/a.ts"]}', []],
    ['nothing to check yet', 'completed', 'not json', []]
  ])('says %s', (summary, taskStatus, result, changedFiles) => {
    expect(describeTaskClaimReconciliation({ taskStatus, result, changedFiles })).toBe(summary)
  })

  it('counts the two mismatch directions separately', () => {
    expect(
      describeTaskClaimReconciliation({
        taskStatus: 'completed',
        result: '{"filesModified":["src/a.ts","src/b.ts"]}',
        changedFiles: ['src/c.ts']
      })
    ).toBe('claimed 2 file(s) git does not show as changed')
    expect(
      describeTaskClaimReconciliation({
        taskStatus: 'completed',
        result: '{"filesModified":["src/a.ts"]}',
        changedFiles: ['src/a.ts', 'src/surprise.ts']
      })
    ).toBe('changed 1 file(s) it did not claim')
  })
})

describe('the closed audit bypass', () => {
  it('is triggerable by a plain write, because the stored column is pure ASCII', () => {
    // JSON.stringify spells the unpaired unit as six ASCII characters, so the
    // column stores and encodes with nothing throwing upstream — which is why
    // any agent can reach this row with one filename.
    expect([...SURROGATE_RESULT].every((char) => char.charCodeAt(0) < 128)).toBe(true)
    expect(SURROGATE_RESULT).toContain('\\ud800')
  })

  it('answers mismatch with the files listed, where it answered unknown', () => {
    expect(
      reconcileTaskClaim({
        taskStatus: 'completed',
        result: SURROGATE_RESULT,
        changedFiles: ['src/b.ts']
      })
    ).toEqual({
      verdict: 'mismatch',
      claimed: ['src/a.ts', 'src/b.ts'],
      missing: ['src/a.ts'],
      unclaimed: []
    })
  })

  it('restores the REASON, not just the verdict', () => {
    // A supervisor acts on the reason: this claim parses fine and it is GIT that
    // is missing. Same word "unknown", two completely different follow-ups.
    expect(
      reconcileTaskClaim({ taskStatus: 'completed', result: SURROGATE_RESULT, changedFiles: null })
    ).toEqual({ verdict: 'unknown', reason: 'no-git' })
  })

  it('keeps every other entry of the claim readable', () => {
    expect(parseTaskClaim(SURROGATE_RESULT)).toEqual({
      completedBy: `w${REPAIRED}`,
      filesModified: ['src/a.ts', 'src/b.ts']
    })
  })

  it('still refuses a document the twin also refused', () => {
    // The repair must not launder a real syntax error, or a truncated escape.
    expect(parseTaskClaim('{"completedBy":"w\\ud800","filesModified":["a.ts",]}')).toBeNull()
    expect(parseTaskClaim('{"completedBy":"w\\ud80","filesModified":["a.ts"]}')).toBeNull()
  })
})

// Pinned so the shim header's declarations cannot quietly stop being true. Each
// one is a place the core answers differently from the deleted twin, and
// `pnpm parity` can no longer see them: both of its legs are now the core.
describe('declared residuals', () => {
  const inPath = '{"completedBy":"w1","filesModified":["src/a\\ud800.ts"]}'

  it('1: a surrogate inside a path repairs to U+FFFD and still lands in missing', () => {
    // Twin: the unpaired code unit. Core: U+FFFD. Both compare unequal to git.
    expect(
      reconcileTaskClaim({ taskStatus: 'completed', result: inPath, changedFiles: ['src/a.ts'] })
    ).toEqual({
      verdict: 'mismatch',
      claimed: [`src/a${REPAIRED}.ts`],
      missing: [`src/a${REPAIRED}.ts`],
      unclaimed: ['src/a.ts']
    })
  })

  it('2: reads match where the twin read mismatch, once git also reads U+FFFD', () => {
    // The status parser decodes git's bytes lossily, so an invalid-UTF-8 file
    // name arrives as U+FFFD too and the repaired entry now compares EQUAL.
    expect(
      reconcileTaskClaim({
        taskStatus: 'completed',
        result: inPath,
        changedFiles: [`src/a${REPAIRED}.ts`]
      })
    ).toEqual({ verdict: 'match', claimed: [`src/a${REPAIRED}.ts`] })
  })

  it('3: a result nested deeper than 128 frames reads unreadable-result', () => {
    const deep = `{"filesModified":["src/a.ts"],"trace":${'['.repeat(130)}${']'.repeat(130)}}`
    expect(
      reconcileTaskClaim({ taskStatus: 'completed', result: deep, changedFiles: ['src/a.ts'] })
    ).toEqual({ verdict: 'unknown', reason: 'unreadable-result' })
  })

  it('4: one f64-overflowing literal costs the whole verdict', () => {
    expect(
      reconcileTaskClaim({
        taskStatus: 'completed',
        result: '{"filesModified":["src/a.ts"],"durationMs":1e999}',
        changedFiles: ['src/a.ts']
      })
    ).toEqual({ verdict: 'unknown', reason: 'unreadable-result' })
  })
})

describe('input adapters', () => {
  it.each([
    ['a non-string status', 7],
    ['an absent status', undefined]
  ])('treats %s as not-completed instead of crossing it', (_label, taskStatus) => {
    expect(
      reconcileLoosely({ taskStatus, result: '{"filesModified":[]}', changedFiles: [] })
    ).toEqual({ verdict: 'unknown', reason: 'not-completed' })
  })

  it('reads an absent result as unreadable-result, not as an encoder rejection', () => {
    // An `undefined` property is REJECTED by the dispatch codec, so the adapter
    // has to make the twin's choice before the payload is built.
    expect(reconcileLoosely({ taskStatus: 'completed', changedFiles: [] })).toEqual({
      verdict: 'unknown',
      reason: 'unreadable-result'
    })
  })

  it('reads a non-array changedFiles as no-git — the safe degradation', () => {
    expect(
      reconcileLoosely({ taskStatus: 'completed', result: '{"filesModified":["a.ts"]}' })
    ).toEqual({ verdict: 'unknown', reason: 'no-git' })
  })

  it('coerces git entries rather than dropping them', () => {
    // A dropped entry the worker claimed becomes a false accusation, and a
    // dropped entry it did not claim turns a real mismatch into a clean bill.
    expect(
      reconcileLoosely({
        taskStatus: 'completed',
        result: '{"filesModified":["a.ts"]}',
        changedFiles: ['a.ts', 7]
      })
    ).toEqual({ verdict: 'mismatch', claimed: ['a.ts'], missing: [], unclaimed: ['7'] })
  })

  it('coerces a result the way JSON.parse coerced it', () => {
    expect(
      reconcileLoosely({
        taskStatus: 'completed',
        result: ['{"completedBy":"w1","filesModified":["a.ts"]}'],
        changedFiles: ['a.ts']
      })
    ).toEqual({ verdict: 'match', claimed: ['a.ts'] })
  })
})

describe('the seam contract', () => {
  const claim: TaskClaimInputs = {
    taskStatus: 'completed',
    result: '{"filesModified":["a.ts"]}',
    changedFiles: []
  }

  it('throws unbound, because main installs its binding before any runtime code', () => {
    // Main-only: there is no pre-ready window to degrade into, so an unbound
    // seam is a bootstrap-order bug and must be loud rather than answer.
    setOrcaDispatchBinding(null)
    expect(() => reconcileTaskClaim(claim)).toThrow(/seam not bound for task-claim/)
    expect(() => describeTaskClaimReconciliation(claim)).toThrow(/seam not bound for task-claim/)
    expect(() => parseTaskClaim('{}')).toThrow(/seam not bound for task-claim/)
  })

  it('answers again once the binding is back', () => {
    setOrcaDispatchBinding(null)
    bindWasm()
    expect(reconcileTaskClaim(claim)).toMatchObject({ verdict: 'mismatch' })
  })
})

// The wasm core above is the byte-identical twin of napi, but main dispatches
// through napi and nothing else — so the rows that carry the alert get run
// against the binding that actually ships. Skips when the .node is absent.
const napiBinding = loadRustGitBinding()
const napiSuite = napiBinding ? describe : describe.skip

napiSuite('through the napi binding main installs', () => {
  function bindNapi(): void {
    if (!napiBinding) {
      throw new Error('the napi suite ran without the addon it is gated on')
    }
    setOrcaDispatchBinding((module, fn, inputJson) =>
      napiBinding.orcaDispatch(module, fn, inputJson)
    )
  }

  it('contradicts the agent and answers the closed bypass, same as wasm', () => {
    bindNapi()
    expect(
      reconcileTaskClaim({
        taskStatus: 'completed',
        result: '{"filesModified":["src/a.ts"]}',
        changedFiles: []
      })
    ).toEqual({ verdict: 'mismatch', claimed: ['src/a.ts'], missing: ['src/a.ts'], unclaimed: [] })
    expect(
      reconcileTaskClaim({ taskStatus: 'completed', result: SURROGATE_RESULT, changedFiles: null })
    ).toEqual({ verdict: 'unknown', reason: 'no-git' })
    expect(
      reconcileTaskClaim({
        taskStatus: 'completed',
        result: SURROGATE_RESULT,
        changedFiles: ['src/b.ts']
      })
    ).toEqual({
      verdict: 'mismatch',
      claimed: ['src/a.ts', 'src/b.ts'],
      missing: ['src/a.ts'],
      unclaimed: []
    })
    expect(
      describeTaskClaimReconciliation({
        taskStatus: 'completed',
        result: SURROGATE_RESULT,
        changedFiles: ['src/b.ts']
      })
    ).toBe('claimed 1 file(s) git does not show as changed')
  })
})
