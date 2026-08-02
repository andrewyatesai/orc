/**
 * Context-management verbs for a driving AI — `terminal.history`,
 * `terminal.blocks`, `terminal.blockText`, `terminal.agentView`.
 *
 * Why a sibling module and not more entries in terminal.ts: these four are one
 * capability (orient in a pane you are not looking at) and share one honesty
 * contract — every result names the channels it could not serve rather than
 * returning a plausible empty, the same no-silent-downgrade rule
 * `terminal.await` follows for unproducible fact kinds.
 *
 * Design map: docs/reference/alab-agent-visibility.md §§3, 5.1, 9.
 */
import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'

const TerminalHandle = z.object({
  terminal: requiredString('Missing terminal handle')
})

const TerminalHistoryParams = TerminalHandle.extend({
  // A stable host row, as returned by terminal.search matches or by this verb's
  // own previousHostRow/nextHostRow. Omitted means "the newest window".
  from: z.number().int().nonnegative().optional(),
  count: OptionalFiniteNumber
})

const TerminalBlocksParams = TerminalHandle.extend({
  limit: OptionalFiniteNumber
})

const TerminalBlockTextParams = TerminalHandle.extend({
  // Omitted means the newest retained block — the common "what did that last
  // command print" question.
  index: z.number().int().nonnegative().optional(),
  limit: OptionalFiniteNumber
})

export const TERMINAL_CONTEXT_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.history',
    params: TerminalHistoryParams,
    handler: async (params, { runtime, signal }) => ({
      history: await runtime.readTerminalHistory(params.terminal, {
        ...(params.from !== undefined ? { from: params.from } : {}),
        ...(params.count !== undefined ? { count: params.count } : {}),
        signal
      })
    })
  }),
  defineMethod({
    name: 'terminal.blocks',
    params: TerminalBlocksParams,
    handler: async (params, { runtime }) => ({
      // Absent optionals are omitted, not defaulted here: bounds live in one
      // place (the runtime), so a CLI and a socket caller get the same window.
      blocks: runtime.listTerminalCommandBlocks(
        params.terminal,
        params.limit === undefined ? {} : { limit: params.limit }
      )
    })
  }),
  defineMethod({
    name: 'terminal.blockText',
    params: TerminalBlockTextParams,
    handler: async (params, { runtime }) => ({
      blockText: runtime.readTerminalCommandBlockText(params.terminal, {
        ...(params.index !== undefined ? { index: params.index } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {})
      })
    })
  }),
  defineMethod({
    name: 'terminal.agentView',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      agentView: await runtime.readTerminalAgentView(params.terminal)
    })
  })
]
