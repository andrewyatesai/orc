/**
 * `terminal.submitAgentPrompt` — §5.2 of docs/reference/alab-auto-mode-design.md.
 *
 * A sibling of `terminal.await`, not an option on `terminal.send`: send reports
 * bytes accepted, which over SSH is explicitly not delivery proof
 * (`ipc/pty.ts:5210`), and it has nowhere to carry a verdict, an evidence tier or
 * a draft state. Widening it would change what every existing caller means.
 *
 * The handler stays thin on purpose — every decision in the result was made by
 * the state machine under the pane's input lease, and re-deriving any of it here
 * would be a second opinion nobody asked for.
 */
import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'

/** Long enough for a hook round-trip on a relayed pane, short enough that a
 *  caller is not left holding a socket. Past it the verdict is `'unknown'`,
 *  never a false `'no'`. */
const MAX_SETTLE_BUDGET_MS = 60_000

const TerminalSubmitAgentPromptParams = z.object({
  terminal: requiredString('Missing terminal handle'),
  prompt: requiredString('Missing prompt'),
  settleBudgetMs: OptionalFiniteNumber
})

function resolveSettleBudgetMs(requested: number | undefined): number | undefined {
  if (requested === undefined || requested <= 0) {
    return undefined
  }
  return Math.min(requested, MAX_SETTLE_BUDGET_MS)
}

export const TERMINAL_SUBMIT_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.submitAgentPrompt',
    params: TerminalSubmitAgentPromptParams,
    handler: async (params, { runtime, signal }) => {
      const settleBudgetMs = resolveSettleBudgetMs(params.settleBudgetMs)
      return {
        submit: await runtime.submitAgentPrompt(params.terminal, params.prompt, {
          ...(settleBudgetMs !== undefined ? { settleBudgetMs } : {}),
          // A disconnected caller stops the poll; it never converts an armed
          // submit into a failure, because Enter has already landed.
          ...(signal ? { signal } : {})
        })
      }
    }
  })
]
