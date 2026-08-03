/**
 * `terminal.record*` — start, stop and locate asciicast recordings of a pane
 * (docs/reference/alab-agent-visibility.md §7).
 *
 * A sibling module rather than more entries in terminal-context.ts because
 * recording is the one capability here that produces an ARTIFACT: it has a
 * lifecycle, a file, caps and a retention policy, none of which the read-only
 * context verbs have.
 */
import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'

const TerminalHandle = z.object({
  terminal: requiredString('Missing terminal handle')
})

const TerminalRecordStartParams = TerminalHandle.extend({
  // Geometry the cast declares. Used ONLY when the pane has no live engine to
  // ask; an engine answer always wins, because it is observed rather than told.
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  title: z.string().max(200).optional(),
  // Caps. Clamped in the recorder, and the applied values ride on the result so
  // a caller that asked for more learns it was clamped.
  maxDurationMs: OptionalFiniteNumber,
  maxBytes: OptionalFiniteNumber,
  maxEvents: OptionalFiniteNumber
})

export const TERMINAL_RECORDING_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.recordStart',
    params: TerminalRecordStartParams,
    handler: async (params, { runtime }) => ({
      recording: runtime.startTerminalRecording(params.terminal, {
        ...(params.cols !== undefined ? { cols: params.cols } : {}),
        ...(params.rows !== undefined ? { rows: params.rows } : {}),
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(params.maxDurationMs !== undefined ? { maxDurationMs: params.maxDurationMs } : {}),
        ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        ...(params.maxEvents !== undefined ? { maxEvents: params.maxEvents } : {})
      })
    })
  }),
  defineMethod({
    name: 'terminal.recordStop',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      recording: await runtime.stopTerminalRecording(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.recordList',
    params: z.object({}),
    handler: async (_params, { runtime }) => ({
      recordings: await runtime.listTerminalRecordings()
    })
  })
]
