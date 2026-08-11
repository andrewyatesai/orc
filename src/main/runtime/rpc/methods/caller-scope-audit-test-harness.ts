/**
 * One executed table per policied RPC group.
 *
 * Why: a caller-scope policy is a claim about EVERY method in its group, and
 * five review rounds each found methods the group's one-line reason was false
 * for — a listing that returned every row, a verb that named no host object at
 * all. So the reason stops being a sentence somebody believed: each method is
 * driven under a bounded caller against a world where every readable row belongs
 * to another host and carries {@link AUDIT_SENTINEL}, and must give one of
 * exactly three answers — and each answer covers what the method WRITES as well
 * as what it says, because the sixth miss was a method that leaked no byte and
 * tore down another host's pane anyway. A method added next month fails the
 * coverage check until somebody says which answer it gives.
 */
import { describe, expect, it } from 'vitest'
import { CallerScopeDeniedError, runWithCallerScope } from '../../runtime-caller-scope'
import { isStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'

/** Planted in every readable row, so a byte of the other host's state reaching a
 *  bounded caller shows up in the serialized reply instead of passing for empty. */
export const AUDIT_SENTINEL = 'row_owned_by_another_host'

export const AUDIT_TARGET = 'ssh_target_a'
export const AUDIT_OTHER_TARGET = 'ssh_target_b'

/** The caller every case runs as: a pane on a host that owns none of the world. */
export const AUDIT_CALLER = { kind: 'ssh', connectionId: AUDIT_TARGET } as const

/** Rejects with CallerScopeDeniedError, having written nothing on the way. */
export const REFUSES = 'refuses'
/** Answers with no byte of the other host's state, and changes nothing of theirs. */
export const WITHHOLDS = 'answers without the other host, touching nothing of theirs'
/**
 * Withholds, but the read leaves host bookkeeping behind — a warmed cache, an id
 * stamped on first sighting. A third answer rather than a WITHHOLDS with an
 * excuse: the row has to name the state it writes, so the write is a claim in
 * the table a reviewer can weigh instead of a silence nothing checks.
 */
export const WITHHOLDS_AND_WRITES = 'answers without the other host, writing only what it declares'

export type CallerScopeAuditAnswer = typeof REFUSES | typeof WITHHOLDS | typeof WITHHOLDS_AND_WRITES

export type CallerScopeAuditCase =
  | { readonly params: unknown; readonly answer: typeof REFUSES | typeof WITHHOLDS }
  | {
      readonly params: unknown
      readonly answer: typeof WITHHOLDS_AND_WRITES
      /** Exactly the host-state fields the run may leave changed — no more, no fewer. */
      readonly writes: readonly string[]
    }

export type CallerScopeGroupAudit = {
  /** The registered group this table has to cover exactly. */
  readonly methods: readonly RpcAnyMethod[]
  /** Rebuilt per case, so one method's writes cannot answer for the next. */
  readonly createContext: () => RpcContext
  /**
   * The other host's mutable state, digested field by field. Required rather
   * than opt-in: every row is checked against it automatically, so the write
   * half of the claim cannot be the half a table forgot to ask for.
   */
  readonly captureHostState: (ctx: RpcContext) => Record<string, string>
  readonly cases: Readonly<Record<string, CallerScopeAuditCase>>
}

/** Teardown and persistence are fire-and-forget, so the write lands after the reply. */
async function settlePendingWrites(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function changedFields(
  before: Record<string, string>,
  after: Record<string, string>
): readonly string[] {
  return Object.keys({ ...before, ...after })
    .filter((field) => before[field] !== after[field])
    .sort()
}

/** Calling the handler directly skips the schema, and the dispatcher never does:
 *  it parses params first and only then calls the handler — the wrapped one
 *  included, so a guarded group's guard runs after its schema, not before. A row
 *  whose params that schema would reject therefore drives a call no caller can
 *  make, which is why the tables give each row params the schema accepts. */
async function callUnderBound(
  method: RpcAnyMethod,
  params: unknown,
  ctx: RpcContext,
  emitted: unknown[]
): Promise<unknown> {
  return await runWithCallerScope(AUDIT_CALLER, async () =>
    isStreamingMethod(method)
      ? method.handler(params, ctx, (value: unknown) => emitted.push(value))
      : method.handler(params, ctx)
  )
}

/**
 * Registers the group's table as its own describe block. Call it once per
 * policied group; {@link CALLER_SCOPE_AUDITS} is what makes skipping one fail.
 */
export function auditCallerScopeGroup(group: string, audit: CallerScopeGroupAudit): void {
  describe(`${group} — every method answers the caller bound`, () => {
    it('the table covers exactly the methods the group registers', () => {
      expect(audit.methods.map((method) => method.name).sort()).toEqual(
        Object.keys(audit.cases).sort()
      )
    })

    const rows = Object.entries(audit.cases).map(
      ([name, testCase]) =>
        [
          name,
          testCase.answer,
          testCase.params,
          testCase.answer === WITHHOLDS_AND_WRITES ? testCase.writes : []
        ] as const
    )
    it.each(rows)('%s %s', async (name, answer, params, writes) => {
      const method = audit.methods.find((candidate) => candidate.name === name)
      if (!method) {
        throw new Error(`no such method: ${name}`)
      }
      const emitted: unknown[] = []
      const ctx = audit.createContext()
      const before = audit.captureHostState(ctx)
      const call = callUnderBound(method, params, ctx, emitted)
      if (answer === REFUSES) {
        // Why the error type rather than "it threw": a write tripwire, a missing
        // double or a validation slip also rejects, and would read as a pass
        // while the bound was in fact absent. The message carries whatever the
        // method said instead, because "not a refusal" is the whole finding.
        const outcome = await call.then(
          (value) => ({ refused: false, said: JSON.stringify([value, emitted]) }),
          (thrown: unknown) => ({
            refused: thrown instanceof CallerScopeDeniedError,
            said: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
          })
        )
        expect(outcome.refused, `${name} answered ${outcome.said}`).toBe(true)
        // A refusal is only a bound if it landed before the work did: a method
        // that tears something down and then refuses has already spent the
        // authority it is denying.
        await settlePendingWrites()
        expect(
          changedFields(before, audit.captureHostState(ctx)),
          `${name} refused only after writing`
        ).toEqual([])
        return
      }
      // Emitted frames count: a streaming verb hands rows over the same socket.
      expect(JSON.stringify([await call, emitted]) ?? 'undefined').not.toContain(AUDIT_SENTINEL)
      // Why the reply is not the whole answer: a method that tears down another
      // host's pane and returns {ok:true} leaks no byte and passes the check
      // above — the sixth miss was exactly that shape. So withholding also means
      // "changed nothing it does not own", checked against the world itself.
      await settlePendingWrites()
      const after = audit.captureHostState(ctx)
      if (answer === WITHHOLDS) {
        expect(after, `${name} answered without the other host, then changed their state`).toEqual(
          before
        )
        return
      }
      // Declared writes are checked in both directions: an undeclared field is a
      // write nobody claimed, and a declared one that stopped moving is a claim
      // that has outlived the code it described.
      expect(
        changedFields(before, after),
        `${name} wrote host state other than the fields it declares`
      ).toEqual([...writes].sort())
    })
  })
}
