/**
 * `terminal.await` — cursor-based multi-pane long poll over the terminal event
 * journal (§5.3 of docs/reference/alab-auto-mode-design.md).
 *
 * Why a sibling verb and not an extension of `terminal.wait`: wait is
 * single-handle by contract (`terminal` + `for: exit|tui-idle`), resolves a
 * latched *state* rather than an event, and returns a RuntimeTerminalWait that
 * has no place to carry per-pane cursors. Widening it would change the meaning
 * of every existing `orca terminal wait` call; await is additive instead.
 */
import { z } from 'zod'
import { InvalidArgumentError, defineMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'
import {
  TERMINAL_AWAIT_DEFAULT_TIMEOUT_MS,
  TERMINAL_AWAIT_MAX_PANES,
  TERMINAL_AWAIT_MAX_TIMEOUT_MS,
  type TerminalAwaitPane
} from '../../terminal-multi-pane-await'
import { TERMINAL_AWAIT_AWAITABLE_FACT_KINDS } from '../../terminal-await-fact-kinds'

const EventCursorSchema = z.object({
  runtimeId: requiredString('Missing cursor runtimeId').pipe(z.string().max(256)),
  ptyIncarnationId: requiredString('Missing cursor ptyIncarnationId').pipe(z.string().max(256)),
  eventSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
})

const TerminalAwaitParams = z.object({
  terminals: z
    .array(
      z.object({
        terminal: requiredString('Missing terminal handle'),
        // Absent on a first arm: the runtime starts the reader at the pane's
        // newest retained position ("tell me what happens next").
        cursor: EventCursorSchema.optional()
      })
    )
    .min(1)
    .max(TERMINAL_AWAIT_MAX_PANES),
  // Fact-kind filter; omitted means any fact. `agent-state <state>` maps onto
  // 'agent-working' | 'agent-idle' | 'agent-exited'. Every kind the journal can
  // carry is accepted, so a typo fails loudly instead of long-polling forever;
  // the ones whose scanners exist only while a renderer consumer is attached
  // stay valid here — they are real in a windowed runtime — and come back as
  // `outcome:'unsupported'` naming them when this posture cannot produce them.
  kinds: z
    .array(
      z.string().refine((kind) => TERMINAL_AWAIT_AWAITABLE_FACT_KINDS.has(kind), {
        message: 'Unknown terminal fact kind'
      })
    )
    .min(1)
    .max(TERMINAL_AWAIT_AWAITABLE_FACT_KINDS.size)
    .optional(),
  timeoutMs: OptionalFiniteNumber
})

function resolveTimeoutMs(requested: number | undefined): number {
  if (requested === undefined || requested <= 0) {
    return TERMINAL_AWAIT_DEFAULT_TIMEOUT_MS
  }
  return Math.min(requested, TERMINAL_AWAIT_MAX_TIMEOUT_MS)
}

function assertDistinctTerminals(panes: readonly TerminalAwaitPane[]): void {
  // Why: two entries for one pane would carry two cursors for the same journal
  // position, and the caller could not tell which return applied to which.
  const seen = new Set<string>()
  for (const pane of panes) {
    if (seen.has(pane.ptyId)) {
      throw new InvalidArgumentError(`Duplicate terminal in await set: ${pane.terminal}`)
    }
    seen.add(pane.ptyId)
  }
}

export const TERMINAL_AWAIT_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.await',
    params: TerminalAwaitParams,
    handler: async (params, { runtime, signal }) => {
      runtime.assertFleetVerbEnabled('terminal.await')
      const panes = params.terminals.map((entry) =>
        runtime.resolveTerminalEventPane(entry.terminal, entry.cursor)
      )
      assertDistinctTerminals(panes)
      return {
        // Why the kind filter is handed over whole rather than pre-compiled into
        // a predicate: only the runtime knows which kinds its current posture can
        // produce, and it must say so instead of parking on an impossible match.
        await: await runtime.awaitTerminalEvents(panes, {
          ...(params.kinds ? { kinds: params.kinds } : {}),
          timeoutMs: resolveTimeoutMs(params.timeoutMs),
          signal
        })
      }
    }
  })
]
