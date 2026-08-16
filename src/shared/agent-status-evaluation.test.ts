// The agent-status twin's suite, moved off the deleted implementation half of
// `agent-status-types.ts` onto the seam shim. Every case runs TWICE — seam
// unbound (the renderer before wasm init, and for the whole session if wasm
// never lands) and bound to the wasm core (what ships once it does) — and the
// two answers are compared with `shapeOf`, which distinguishes an own key whose
// value is `undefined` from an absent one. That matters here: the twin's object
// literal always carries all eleven payload keys, `JSON.stringify` drops exactly
// the undefined ones, and `Object.keys`/`in`/spread over the result would
// otherwise differ between the two seam states.
//
// That unbound-vs-bound equality IS this module's pre-ready gate. The shared
// gate at `renderer/src/lib/git-wasm/shim-pre-ready-contract.test.ts` cannot
// carry it: its working-tree copy imports five shims that do not exist at HEAD
// (contextual-tour-id-normalization, pairing-deep-link,
// setup-runner-command-resolution, worktree-id-parsing,
// mcp-config-content-inspection), so staging it would commit a file that cannot
// load. `PRE_READY_CONTRACT` below declares the same `parity` rows in the same
// shape.
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  agentSubagentsEqual,
  hasUnsettledOrUnknownDispatch,
  isFreshNonDoneAgentStatus,
  normalizeAgentStatusPayload,
  parseAgentStatusPayload
} from './agent-status-evaluation'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import {
  AGENT_STATUS_JSON_STRUCTURE_LIMITS,
  AGENT_STATUS_MAX_FIELD_LENGTH,
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH,
  AGENT_STATUS_STALE_AFTER_MS,
  AGENT_STATUS_STATES,
  AGENT_TYPE_MAX_LENGTH,
  type AgentSubagentSnapshot
} from './agent-status-types'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

/** A JSON-safe descriptor that keeps own keys whose value is `undefined`, so a
 *  lean core answer cannot pass for the twin's fully-keyed literal. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(shapeOf)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        child === undefined ? '<undefined>' : shapeOf(child)
      ])
    )
  }
  return value
}

/** The answer, proved identical unbound and bound. */
function agreed<T>(call: () => T): T {
  setOrcaDispatchBinding(null)
  const unbound = call()
  bindWasm()
  const bound = call()
  setOrcaDispatchBinding(null)
  expect(shapeOf(bound)).toEqual(shapeOf(unbound))
  return unbound
}

/** For the cases that assert on the FALLBACK's internals (which functions it
 *  did not call). Bound, the TypeScript body never runs, so the spy would be
 *  satisfied by a shim that answered anything at all. */
function unbound<T>(call: () => T): T {
  setOrcaDispatchBinding(null)
  return call()
}

/** The raw core answer, with no shim guard in the way. */
function rawCore(fn: string, input: unknown): unknown {
  return JSON.parse(orcaDispatch('agent-status-types', fn, JSON.stringify(input)))
}

afterEach(() => {
  setOrcaDispatchBinding(null)
  vi.restoreAllMocks()
})

describe('parseAgentStatusPayload', () => {
  it('parses a valid working payload', () => {
    const result = agreed(() =>
      parseAgentStatusPayload(
        '{"state":"working","prompt":"Fix the flaky assertion","agentType":"codex"}'
      )
    )
    expect(result).toEqual({
      state: 'working',
      prompt: 'Fix the flaky assertion',
      agentType: 'codex'
    })
  })

  it('parses all AGENT_STATUS_STATES', () => {
    for (const state of AGENT_STATUS_STATES) {
      const result = agreed(() => parseAgentStatusPayload(`{"state":"${state}"}`))
      expect(result).not.toBeNull()
      expect(result!.state).toBe(state)
    }
  })

  it('returns null for invalid state', () => {
    expect(agreed(() => parseAgentStatusPayload('{"state":"running"}'))).toBeNull()
    expect(agreed(() => parseAgentStatusPayload('{"state":"idle"}'))).toBeNull()
    expect(agreed(() => parseAgentStatusPayload('{"state":""}'))).toBeNull()
  })

  it('returns null when state is a non-string type', () => {
    expect(agreed(() => parseAgentStatusPayload('{"state":123}'))).toBeNull()
    expect(agreed(() => parseAgentStatusPayload('{"state":true}'))).toBeNull()
    expect(agreed(() => parseAgentStatusPayload('{"state":null}'))).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(agreed(() => parseAgentStatusPayload('not json'))).toBeNull()
    expect(agreed(() => parseAgentStatusPayload('{broken'))).toBeNull()
    expect(agreed(() => parseAgentStatusPayload(''))).toBeNull()
  })

  it('rejects excessive nesting before JSON.parse', () => {
    const depth = AGENT_STATUS_JSON_STRUCTURE_LIMITS.nestingDepth + 1
    const overNested = `${'['.repeat(depth)}0${']'.repeat(depth)}`
    expect(agreed(() => parseAgentStatusPayload(overNested))).toBeNull()
    // The "before JSON.parse" half is an assertion about the fallback's own
    // body; bound, `decodeDispatchResult` parses the response and the spy would
    // see that call instead.
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      expect(unbound(() => parseAgentStatusPayload(overNested))).toBeNull()
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })

  it('returns null for non-object JSON', () => {
    expect(agreed(() => parseAgentStatusPayload('"just a string"'))).toBeNull()
    expect(agreed(() => parseAgentStatusPayload('42'))).toBeNull()
    expect(agreed(() => parseAgentStatusPayload('null'))).toBeNull()
    expect(agreed(() => parseAgentStatusPayload('[]'))).toBeNull()
  })

  it('normalizes multiline prompt to single line', () => {
    const result = agreed(() =>
      parseAgentStatusPayload('{"state":"working","prompt":"line one\\nline two\\nline three"}')
    )
    expect(result!.prompt).toBe('line one line two line three')
  })

  it('normalizes Windows-style line endings (\\r\\n) to single line', () => {
    const result = agreed(() =>
      parseAgentStatusPayload(
        '{"state":"working","prompt":"line one\\r\\nline two\\r\\nline three"}'
      )
    )
    expect(result!.prompt).toBe('line one line two line three')
  })

  it('trims whitespace from the prompt field', () => {
    const result = agreed(() =>
      parseAgentStatusPayload('{"state":"working","prompt":"  padded  "}')
    )
    expect(result!.prompt).toBe('padded')
  })

  it('truncates the prompt beyond max length', () => {
    const longString = 'x'.repeat(300)
    const result = agreed(() =>
      parseAgentStatusPayload(`{"state":"working","prompt":"${longString}"}`)
    )
    expect(result!.prompt).toHaveLength(AGENT_STATUS_MAX_FIELD_LENGTH)
  })

  // Why: dispatch preambles bury the task body after multi-KB CLI text; naive head-truncation would keep only boilerplate.
  it('compacts Orca dispatch preambles so the task body survives 200-char truncation', () => {
    const longCliNoise = Array.from(
      { length: 50 },
      (_, i) => `orca orchestration send --to term_parent --type heartbeat --phase step-${i}`
    ).join('\n')
    const result = agreed(() =>
      parseAgentStatusPayload(
        JSON.stringify({
          state: 'working',
          prompt: `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your task ID is: task_compact_1

=== CLI COMMANDS ===
${longCliNoise}

=== TASK ===
Fix dispatch fallback preview for normalized status prompts`
        })
      )
    )
    expect(result).not.toBeNull()
    expect(result!.prompt.length).toBeLessThanOrEqual(AGENT_STATUS_MAX_FIELD_LENGTH)
    expect(result!.prompt.includes('\n')).toBe(false)
    expect(result!.prompt.startsWith('You are working inside Orca, a multi-agent IDE.')).toBe(true)
    expect(result!.prompt).toContain('Your task ID is: task_compact_1')
    expect(result!.prompt).toContain('=== TASK ===')
    expect(result!.prompt).toContain('Fix dispatch fallback preview')
    expect(result!.prompt).not.toContain('CLI COMMANDS')
    expect(result!.prompt).not.toContain('heartbeat')
  })

  it('ignores task-marker text inside base-drift commit subjects', () => {
    const result = agreed(() =>
      normalizeAgentStatusPayload({
        state: 'working',
        // Why: CRLF covers Windows hook payloads; commit text must not impersonate the task separator.
        prompt: [
          'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.',
          'Your task ID is: task_drift_marker',
          '',
          '--- BASE DRIFT ---',
          '  - docs: explain === TASK === marker parsing',
          '---',
          '',
          '=== TASK ===',
          'Fix the actual dispatch fallback preview'
        ].join('\r\n')
      })
    )

    expect(result!.prompt).toContain('=== TASK === Fix the actual dispatch fallback preview')
    expect(result!.prompt).not.toContain('marker parsing')
  })

  it('keeps dispatch detection bounded for oversized whitespace prompts', () => {
    const prompt = ' '.repeat(1_000_000)
    expect(agreed(() => normalizeAgentStatusPayload({ state: 'working', prompt })!.prompt)).toBe('')

    const trimStartSpy = vi.spyOn(String.prototype, 'trimStart')
    unbound(() => normalizeAgentStatusPayload({ state: 'working', prompt }))
    expect(
      trimStartSpy.mock.contexts.some((context) => String(context).length === prompt.length)
    ).toBe(false)
  })

  it('defaults missing prompt to empty string', () => {
    const result = agreed(() => parseAgentStatusPayload('{"state":"done"}'))
    expect(result!.prompt).toBe('')
  })

  it('handles non-string prompt gracefully', () => {
    const result = agreed(() => parseAgentStatusPayload('{"state":"working","prompt":42}'))
    expect(result!.prompt).toBe('')
  })

  it('accepts custom non-empty agentType values', () => {
    const result = agreed(() => parseAgentStatusPayload('{"state":"working","agentType":"cursor"}'))
    expect(result).toEqual({
      state: 'working',
      prompt: '',
      agentType: 'cursor'
    })
  })

  it('truncates agentType beyond AGENT_TYPE_MAX_LENGTH', () => {
    const longAgentType = 'a'.repeat(AGENT_TYPE_MAX_LENGTH + 20)
    const result = agreed(() =>
      parseAgentStatusPayload(JSON.stringify({ state: 'working', agentType: longAgentType }))
    )
    expect(result!.agentType).toHaveLength(AGENT_TYPE_MAX_LENGTH)
  })

  it('treats whitespace-only agentType as undefined', () => {
    const result = agreed(() => parseAgentStatusPayload('{"state":"working","agentType":"   "}'))
    expect(result!.agentType).toBeUndefined()
  })

  it('collapses newlines in agentType (single-line field)', () => {
    // Why: agentType is single-line; a newline must not leak into UI rendering or equality checks.
    const result = agreed(() =>
      parseAgentStatusPayload('{"state":"working","agentType":"claude\\nrogue"}')
    )
    expect(result!.agentType).toBe('claude rogue')
  })

  it('parses toolName, toolInput, and lastAssistantMessage', () => {
    const result = agreed(() =>
      parseAgentStatusPayload(
        JSON.stringify({
          state: 'working',
          toolName: 'Edit',
          toolInput: '/path/to/file.ts',
          lastAssistantMessage: 'Here is the edit I made.'
        })
      )
    )
    expect(result).toEqual({
      state: 'working',
      prompt: '',
      agentType: undefined,
      toolName: 'Edit',
      toolInput: '/path/to/file.ts',
      lastAssistantMessage: 'Here is the edit I made.'
    })
  })

  it('parses interactivePrompt without single-line collapse', () => {
    const interactivePrompt = JSON.stringify({
      questions: [{ question: 'Pick one', options: ['a', 'b'] }]
    })
    const result = agreed(() =>
      parseAgentStatusPayload(JSON.stringify({ state: 'waiting', interactivePrompt }))
    )
    // Why: interactivePrompt is raw JSON the client parses back, so content must survive untouched (unlike toolInput).
    expect(result!.interactivePrompt).toBe(interactivePrompt)
  })

  it('preserves newlines inside interactivePrompt JSON', () => {
    const interactivePrompt = '{\n  "questions": []\n}'
    const result = agreed(() =>
      parseAgentStatusPayload(JSON.stringify({ state: 'waiting', interactivePrompt }))
    )
    expect(result!.interactivePrompt).toBe(interactivePrompt)
  })

  it('caps interactivePrompt at its generous max length (not the toolInput cap)', () => {
    const long = 'x'.repeat(AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH + 500)
    const result = agreed(() =>
      parseAgentStatusPayload(JSON.stringify({ state: 'waiting', interactivePrompt: long }))
    )
    expect(result!.interactivePrompt).toHaveLength(AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH)
    expect(AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH).toBe(16000)
  })

  it('leaves interactivePrompt undefined when absent or non-string', () => {
    expect(
      agreed(() => parseAgentStatusPayload('{"state":"working"}'))!.interactivePrompt
    ).toBeUndefined()
    expect(
      agreed(() => parseAgentStatusPayload('{"state":"working","interactivePrompt":42}'))!
        .interactivePrompt
    ).toBeUndefined()
    expect(
      agreed(() => parseAgentStatusPayload('{"state":"working","interactivePrompt":""}'))!
        .interactivePrompt
    ).toBeUndefined()
  })

  it('truncates each optional field to its own cap', () => {
    const longName = 'n'.repeat(AGENT_STATUS_TOOL_NAME_MAX_LENGTH + 50)
    const longInput = 'i'.repeat(AGENT_STATUS_TOOL_INPUT_MAX_LENGTH + 50)
    const longMessage = 'm'.repeat(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH + 500)
    const result = agreed(() =>
      parseAgentStatusPayload(
        JSON.stringify({
          state: 'working',
          toolName: longName,
          toolInput: longInput,
          lastAssistantMessage: longMessage
        })
      )
    )
    expect(result!.toolName).toHaveLength(AGENT_STATUS_TOOL_NAME_MAX_LENGTH)
    expect(result!.toolInput).toHaveLength(AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
    expect(result!.lastAssistantMessage).toHaveLength(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH)
  })

  it('leaves omitted optional fields undefined (not empty string)', () => {
    const result = agreed(() => parseAgentStatusPayload('{"state":"working"}'))
    expect(result!.toolName).toBeUndefined()
    expect(result!.toolInput).toBeUndefined()
    expect(result!.lastAssistantMessage).toBeUndefined()
  })

  it('treats non-string optional fields as undefined', () => {
    const result = agreed(() =>
      parseAgentStatusPayload(
        '{"state":"working","toolName":42,"toolInput":null,"lastAssistantMessage":[]}'
      )
    )
    expect(result!.toolName).toBeUndefined()
    expect(result!.toolInput).toBeUndefined()
    expect(result!.lastAssistantMessage).toBeUndefined()
  })

  it('treats empty-string optional fields as undefined', () => {
    const result = agreed(() =>
      parseAgentStatusPayload(
        '{"state":"working","toolName":"   ","toolInput":"","lastAssistantMessage":"   "}'
      )
    )
    expect(result!.toolName).toBeUndefined()
    expect(result!.toolInput).toBeUndefined()
    expect(result!.lastAssistantMessage).toBeUndefined()
  })

  it('collapses newlines in toolInput (single-line preview field)', () => {
    const result = agreed(() =>
      parseAgentStatusPayload('{"state":"working","toolInput":"line one\\nline two"}')
    )
    expect(result!.toolInput).toBe('line one line two')
  })

  it('normalizes large single-line preview fields without full-string replacement passes', () => {
    const prompt = `Summary\r\nDetails ${'x'.repeat(20_000)}`
    const toolInput = `src/index.ts${String.fromCharCode(0x2028)}${'line\n'.repeat(10_000)}`
    const result = agreed(() =>
      normalizeAgentStatusPayload({ state: 'working', prompt, toolInput })
    )

    expect(result!.prompt.startsWith('Summary Details ')).toBe(true)
    expect(result!.prompt).toHaveLength(AGENT_STATUS_MAX_FIELD_LENGTH)
    expect(result!.toolInput?.startsWith('src/index.ts ')).toBe(true)
    expect(result!.toolInput!.length).toBeLessThanOrEqual(AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)

    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    unbound(() => normalizeAgentStatusPayload({ state: 'working', prompt, toolInput }))
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('bounds scanning when oversized single-line previews are mostly line breaks', () => {
    const prompt = `Summary${'\n'.repeat(10_000)}Details`
    expect(agreed(() => normalizeAgentStatusPayload({ state: 'working', prompt })!.prompt)).toBe(
      'Summary'
    )

    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    unbound(() => normalizeAgentStatusPayload({ state: 'working', prompt }))
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('preserves paragraph breaks in lastAssistantMessage', () => {
    // Why: assistant message renders with whitespace-pre-wrap, so paragraph breaks must survive.
    const result = agreed(() =>
      parseAgentStatusPayload(
        '{"state":"done","lastAssistantMessage":"Summary line.\\n\\nDetails paragraph."}'
      )
    )
    expect(result!.lastAssistantMessage).toBe('Summary line.\n\nDetails paragraph.')
  })

  it('normalizes \\r\\n to \\n and caps blank-line runs at one in lastAssistantMessage', () => {
    const result = agreed(() =>
      parseAgentStatusPayload('{"state":"done","lastAssistantMessage":"a\\r\\nb\\n\\n\\n\\nc"}')
    )
    expect(result!.lastAssistantMessage).toBe('a\nb\n\nc')
  })

  it('normalizes large assistant messages without full-string replacement passes', () => {
    const lastAssistantMessage = `Summary\r\n${'\r\n'.repeat(10_000)}Details ${'x'.repeat(
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
    )}`
    const json = JSON.stringify({ state: 'done', lastAssistantMessage })
    const result = agreed(() => parseAgentStatusPayload(json))

    expect(result!.lastAssistantMessage?.startsWith('Summary\n\nDetails ')).toBe(true)
    expect(result!.lastAssistantMessage!.length).toBeLessThanOrEqual(
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
    )

    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    unbound(() => parseAgentStatusPayload(json))
    const usedMultilineReplace = replaceSpy.mock.calls.some(
      ([pattern]) =>
        pattern instanceof RegExp &&
        ['\\r\\n', '\\r', '[\\u2028\\u2029]', '\\n{3,}'].includes(pattern.source)
    )
    expect(usedMultilineReplace).toBe(false)
  })

  it('folds Unicode line/paragraph separators into \\n and caps blank-line runs in lastAssistantMessage', () => {
    // Why: U+2028/U+2029 render as line breaks under whitespace-pre-wrap; fold to \n so the blank-line cap applies.
    const resultLineSep = agreed(() =>
      parseAgentStatusPayload(
        '{"state":"done","lastAssistantMessage":"a\u2028\u2028\u2028\u2028b"}'
      )
    )
    expect(resultLineSep!.lastAssistantMessage).toBe('a\n\nb')

    const resultParaSep = agreed(() =>
      parseAgentStatusPayload(
        '{"state":"done","lastAssistantMessage":"a\u2029\u2029\u2029\u2029b"}'
      )
    )
    expect(resultParaSep!.lastAssistantMessage).toBe('a\n\nb')

    const resultMixed = agreed(() =>
      parseAgentStatusPayload(
        '{"state":"done","lastAssistantMessage":"a\u2028\u2029\\n\u2028\u2029b"}'
      )
    )
    expect(resultMixed!.lastAssistantMessage).toBe('a\n\nb')
  })

  it('still respects the base prompt cap independent of the new fields', () => {
    const prompt = 'p'.repeat(300)
    const result = agreed(() =>
      parseAgentStatusPayload(
        JSON.stringify({ state: 'working', prompt, toolInput: 'x'.repeat(5) })
      )
    )
    expect(result!.prompt).toHaveLength(AGENT_STATUS_MAX_FIELD_LENGTH)
    expect(result!.toolInput).toBe('xxxxx')
  })

  it('preserves interrupted=true when state is done', () => {
    const result = agreed(() => parseAgentStatusPayload('{"state":"done","interrupted":true}'))
    expect(result!.interrupted).toBe(true)
  })

  it('clears interrupted on non-done states (stale-signal suppression)', () => {
    for (const state of ['working', 'blocked', 'waiting'] as const) {
      const result = agreed(() =>
        parseAgentStatusPayload(`{"state":"${state}","interrupted":true}`)
      )
      expect(result!.interrupted).toBeUndefined()
    }
  })

  it('requires strict boolean true for interrupted (rejects truthy non-boolean)', () => {
    // Why: parser uses `=== true`, so truthy string/number sentinels don't count.
    expect(
      agreed(() => parseAgentStatusPayload('{"state":"done","interrupted":"true"}'))!.interrupted
    ).toBeUndefined()
    expect(
      agreed(() => parseAgentStatusPayload('{"state":"done","interrupted":1}'))!.interrupted
    ).toBeUndefined()
    expect(
      agreed(() => parseAgentStatusPayload('{"state":"done","interrupted":"yes"}'))!.interrupted
    ).toBeUndefined()
  })

  it('never leaves a lone high surrogate when truncating mid surrogate-pair', () => {
    // Why: prepend one code unit so truncation lands ON a high surrogate, else the test passes without the guard.
    const prompt = `x${'😀'.repeat(AGENT_STATUS_MAX_FIELD_LENGTH)}`
    const result = agreed(() =>
      parseAgentStatusPayload(JSON.stringify({ state: 'working', prompt }))
    )
    expect(result!.prompt.length).toBeLessThanOrEqual(AGENT_STATUS_MAX_FIELD_LENGTH)
    // Why: guard drops at most ONE trailing high surrogate, so output must still reach max - 1.
    expect(result!.prompt.length).toBeGreaterThanOrEqual(AGENT_STATUS_MAX_FIELD_LENGTH - 1)
    const len = result!.prompt.length
    const last = result!.prompt.charCodeAt(len - 1)
    const secondLast = len >= 2 ? result!.prompt.charCodeAt(len - 2) : 0
    const isLoneHighSurrogate = last >= 0xd800 && last <= 0xdbff
    expect(isLoneHighSurrogate).toBe(false)
    // Why: a trailing low surrogate must follow a high surrogate, else it's also malformed UTF-16.
    if (last >= 0xdc00 && last <= 0xdfff) {
      expect(secondLast >= 0xd800 && secondLast <= 0xdbff).toBe(true)
    }
  })

  it('never leaves a lone high surrogate in lastAssistantMessage truncation', () => {
    // Why: cover the multiline surrogate-pair guard too, so a refactor can't drop it on one side.
    const surrogatePairs = Math.floor(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH / 2) + 1
    // Why: prepend one code unit so truncation lands ON a high surrogate, else the test passes without the guard.
    const message = `x${'😀'.repeat(surrogatePairs)}`
    const result = agreed(() =>
      parseAgentStatusPayload(JSON.stringify({ state: 'done', lastAssistantMessage: message }))
    )
    expect(result!.lastAssistantMessage!.length).toBeLessThanOrEqual(
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
    )
    // Why: guard drops at most ONE trailing high surrogate, so output must still reach max - 1.
    expect(result!.lastAssistantMessage!.length).toBeGreaterThanOrEqual(
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH - 1
    )
    const len = result!.lastAssistantMessage!.length
    const last = result!.lastAssistantMessage!.charCodeAt(len - 1)
    const secondLast = len >= 2 ? result!.lastAssistantMessage!.charCodeAt(len - 2) : 0
    const isLoneHighSurrogate = last >= 0xd800 && last <= 0xdbff
    expect(isLoneHighSurrogate).toBe(false)
    // Why: a trailing low surrogate must follow a high surrogate, else it's also malformed UTF-16.
    if (last >= 0xdc00 && last <= 0xdfff) {
      expect(secondLast >= 0xd800 && secondLast <= 0xdbff).toBe(true)
    }
  })

  it('normalizes the subagents field, dropping invalid entries and bounding count', () => {
    const result = agreed(() =>
      parseAgentStatusPayload(
        JSON.stringify({
          state: 'working',
          subagents: [
            { id: 'a1', state: 'working', startedAt: 100, agentType: 'general-purpose' },
            { id: 'r1', state: 'idle', startedAt: 'nope', description: 'line\none' },
            { id: '', state: 'working', startedAt: 1 },
            { id: 'bad-state', state: 'running', startedAt: 1 },
            'garbage',
            ...Array.from({ length: AGENT_STATUS_MAX_SUBAGENTS + 5 }, (_, i) => ({
              id: `extra-${i}`,
              state: 'idle',
              startedAt: i
            }))
          ]
        })
      )
    )
    expect(result?.subagents?.length).toBe(AGENT_STATUS_MAX_SUBAGENTS)
    expect(result?.subagents?.[0]).toEqual({
      id: 'a1',
      state: 'working',
      startedAt: 100,
      agentType: 'general-purpose',
      model: undefined,
      description: undefined
    })
    // Why: non-finite startedAt coerces to 0; descriptions fold to one line.
    expect(result?.subagents?.[1]).toMatchObject({
      id: 'r1',
      startedAt: 0,
      description: 'line one'
    })
  })

  it('omits subagents when absent or empty', () => {
    expect(agreed(() => parseAgentStatusPayload('{"state":"done"}'))?.subagents).toBeUndefined()
    expect(
      agreed(() => parseAgentStatusPayload('{"state":"done","subagents":[]}'))?.subagents
    ).toBeUndefined()
  })
})

describe('agentSubagentsEqual', () => {
  const snapshot = { id: 'a1', state: 'working' as const, startedAt: 1 }

  it('compares structurally and treats undefined/empty as distinct from populated', () => {
    expect(agreed(() => agentSubagentsEqual(undefined, undefined))).toBe(true)
    expect(agreed(() => agentSubagentsEqual([snapshot], [{ ...snapshot }]))).toBe(true)
    expect(agreed(() => agentSubagentsEqual([snapshot], [{ ...snapshot, state: 'idle' }]))).toBe(
      false
    )
    expect(
      agreed(() => agentSubagentsEqual([snapshot], [{ ...snapshot, model: 'gpt-5.4-mini' }]))
    ).toBe(false)
    expect(agreed(() => agentSubagentsEqual([snapshot], undefined))).toBe(false)
    expect(agreed(() => agentSubagentsEqual(undefined, [snapshot]))).toBe(false)
    expect(
      agreed(() => agentSubagentsEqual([snapshot], [snapshot, { ...snapshot, id: 'b' }]))
    ).toBe(false)
  })
})

// Why: the per-source hook normalizers construct these literals and validate them
// directly. This pins that the direct path stays identical to the JSON round trip
// they used to take, including where stringify would have altered the payload.
describe('normalizeAgentStatusPayload matches the JSON round trip', () => {
  const CASES: Record<string, unknown>[] = [
    { state: 'working', prompt: 'p', agentType: 'grok', toolName: 'sh', toolInput: 'ls' },
    { state: 'done', prompt: '', agentType: 'devin', interrupted: true },
    // stringify DROPS undefined-valued keys; the direct path passes them through
    {
      state: 'working',
      prompt: 'p',
      agentType: 'cursor',
      toolName: undefined,
      toolInput: undefined,
      interactivePrompt: undefined,
      lastAssistantMessage: undefined,
      interrupted: undefined
    },
    // raw JSON inside a field exercises the structure scanner's in-string path
    {
      state: 'working',
      prompt: 'p',
      agentType: 'copilot',
      interactivePrompt: JSON.stringify({ q: 'pick {one}', options: ['a', 'b'] })
    },
    {
      state: 'working',
      prompt: 'a\r\nb c',
      agentType: 'gemini',
      lastAssistantMessage: 'emoji \u{1f389} 日本語\r\n\r\n\r\nmulti'
    },
    { state: 'working', prompt: 'p', agentType: 'amp', lastAssistantMessage: 'x'.repeat(50_000) },
    { state: 'done', prompt: 'p', agentType: 'hermes', toolName: '', toolInput: '' },
    {
      state: 'working',
      prompt: 'p',
      agentType: 'droid',
      toolInput: '{"nested":{"deep":{"deeper":[1,2,3]}}}'
    },
    {
      state: 'working',
      prompt: 'p',
      agentType: 'kimi',
      lastAssistantMessage: '"escaped" quotes and \\ backslashes'
    },
    { state: 'working', prompt: 'p', agentType: 'opencode' },
    { state: 'done', prompt: 'p', agentType: 'antigravity', interrupted: false },
    { state: 'working', prompt: 'p', agentType: 'pi', toolName: 'x'.repeat(9000) },
    { state: 'working', prompt: 'x'.repeat(9000), agentType: 'omp' },
    {
      state: 'working',
      prompt: 'p',
      agentType: 'command-code',
      lastAssistantMessage: 'tail with \u001b[0m escape codes'
    },
    // a lone surrogate is the case where stringify and a raw read could diverge
    { state: 'working', prompt: 'p', agentType: 'grok', lastAssistantMessage: 'lone \ud800 pair' }
  ]

  it('produces identical output for every normalizer literal shape', () => {
    for (const [index, payload] of CASES.entries()) {
      expect({
        index,
        agent: payload.agentType,
        value: agreed(() => normalizeAgentStatusPayload(payload))
      }).toEqual({
        index,
        agent: payload.agentType,
        value: agreed(() => parseAgentStatusPayload(JSON.stringify(payload)))
      })
    }
  })
})

// ─── Cutover contract ───────────────────────────────────────────────────────

describe('serde refusals the shim repairs', () => {
  // Both are cases where `serde_json` refuses a document `JSON.parse` accepts,
  // so the core answers null; collapsing a null core answer onto the fallback
  // is what keeps the shim at parity. Each is asserted against the RAW core
  // too, so the day the core learns to answer them this test says so.
  it('answers the twin for a lone surrogate escape the core drops', () => {
    const json = '{"state":"working","prompt":"\\ud800"}'
    expect(rawCore('parseAgentStatusPayload', json)).toBeNull()
    const result = agreed(() => parseAgentStatusPayload(json))
    expect(result!.prompt).toBe('\ud800')
  })

  it('answers the twin for a raw lone surrogate the codec cannot encode', () => {
    const json = `{"state":"working","prompt":"\ud800"}`
    const result = agreed(() => parseAgentStatusPayload(json))
    expect(result!.prompt).toBe('\ud800')
  })

  it('answers the twin for an out-of-range JSON number the core drops', () => {
    const json = '{"state":"working","prompt":"hi","updatedAt":1e999}'
    expect(rawCore('parseAgentStatusPayload', json)).toBeNull()
    expect(agreed(() => parseAgentStatusPayload(json))!.prompt).toBe('hi')
  })

  it('answers the twin for a non-finite number on the object path', () => {
    const payload = { state: 'working', subagents: [{ id: 'a', state: 'idle', startedAt: 1 / 0 }] }
    expect(agreed(() => normalizeAgentStatusPayload(payload))!.subagents![0].startedAt).toBe(0)
  })
})

describe('DECLARED RESIDUAL: the single-line scan boundary splits a surrogate pair', () => {
  // The twin emits the dangling HIGH SURROGATE; the core's answer must be a Rust
  // String, so it emits U+FFFD. Pinned, not repaired: the core returns a
  // well-formed payload and nothing at the seam can tell it apart from a real
  // answer. A core that learns to carry unpaired UTF-16 turns this red, and the
  // row gets re-declared as `parity` instead of drifting back.
  const prompt = `${'\n'.repeat(1663)}😀`

  it('diverges on the prompt field, and only there', () => {
    setOrcaDispatchBinding(null)
    expect(normalizeAgentStatusPayload({ state: 'working', prompt })!.prompt).toBe('\ud83d')
    bindWasm()
    expect(normalizeAgentStatusPayload({ state: 'working', prompt })!.prompt).toBe('�')
  })

  it('is the same divergence on the JSON text entry point', () => {
    const json = JSON.stringify({ state: 'working', prompt })
    setOrcaDispatchBinding(null)
    expect(parseAgentStatusPayload(json)!.prompt).toBe('\ud83d')
    bindWasm()
    expect(parseAgentStatusPayload(json)!.prompt).toBe('�')
  })

  it('covers exactly the five single-line fields, and no others', () => {
    // Each single-line field has its own `cap * 8 + 64` bound; the multiline and
    // untouched fields have none, so they stay at parity. Pinned so a change to
    // either set is noticed.
    const SINGLE_LINE: [string, number][] = [
      ['prompt', 200],
      ['agentType', 40],
      ['model', 120],
      ['toolName', 60],
      ['toolInput', 160]
    ]
    for (const [field, cap] of SINGLE_LINE) {
      const value = `${'\n'.repeat(cap * 8 + 63)}😀`
      setOrcaDispatchBinding(null)
      const preReady = normalizeAgentStatusPayload({ state: 'working', [field]: value })
      bindWasm()
      const ready = normalizeAgentStatusPayload({ state: 'working', [field]: value })
      setOrcaDispatchBinding(null)
      expect([field, (preReady as Record<string, unknown>)[field]]).toEqual([field, '\ud83d'])
      expect([field, (ready as Record<string, unknown>)[field]]).toEqual([field, '�'])
    }
    for (const [field, cap] of [
      ['lastAssistantMessage', 8000],
      ['interactivePrompt', 16000]
    ] as [string, number][]) {
      const value = `${'\n'.repeat(cap * 8 + 63)}😀`
      const payload = { state: 'working', [field]: value }
      expect(agreed(() => (normalizeAgentStatusPayload(payload) as never)[field])).toBeDefined()
    }
  })
})

describe('divergences that only appear once the seam is bound', () => {
  // Each of these is a place where the adapter answers something the twin does
  // not. The null-collapse, the extraction and `subagentsCanCross` were each
  // watched failing when removed; the three would-be guards whose removal kept
  // this suite green were DELETED rather than left as tests never seen fail.
  it('parseAgentStatusPayload keeps the twin’s stringify coercion for a non-string', () => {
    // The twin hands the value to JSON.parse, which stringifies an array to its
    // single element; the adapter reads a non-string as absent and answers null.
    const input = ['{"state":"working","prompt":"hi"}'] as unknown as string
    expect(rawCore('parseAgentStatusPayload', input)).toBeNull()
    expect(agreed(() => parseAgentStatusPayload(input))!.prompt).toBe('hi')
  })

  it('hasUnsettledOrUnknownDispatch keeps the twin’s TypeError for a nullish entry', () => {
    const call = (): boolean =>
      hasUnsettledOrUnknownDispatch(undefined as unknown as { orchestration?: undefined })
    expect(rawCore('hasUnsettledOrUnknownDispatch', null)).toBe(false)
    setOrcaDispatchBinding(null)
    expect(call).toThrow(TypeError)
    bindWasm()
    expect(call).toThrow(TypeError)
  })

  it('agentSubagentsEqual keeps the twin’s answer where the core refuses', () => {
    // A truthy non-array operand: the twin duck-types `.length`, the core sends
    // back a `__parity_error__` that would THROW through decodeDispatchResult.
    const notAList = 'ab' as unknown as AgentSubagentSnapshot[]
    expect(rawCore('agentSubagentsEqual', { a: notAList, b: notAList })).toHaveProperty(
      '__parity_error__'
    )
    expect(agreed(() => agentSubagentsEqual(notAList, notAList))).toBe(true)
    // A null element the twin reaches: `a === b` short-circuits to true.
    const withNull = [null] as unknown as AgentSubagentSnapshot[]
    expect(agreed(() => agentSubagentsEqual(withNull, withNull))).toBe(true)
  })

  it('isFreshNonDoneAgentStatus stamps `now` at the TS edge', () => {
    // Six production call sites omit `now`; the core REFUSES the call without
    // it rather than reading a clock the two sides cannot share.
    expect(rawCore('isFreshNonDoneAgentStatus', { entry: { state: 'working' } })).toHaveProperty(
      '__parity_error__'
    )
    const fresh = { state: 'working' as const, updatedAt: Date.now() }
    expect(agreed(() => isFreshNonDoneAgentStatus(fresh))).toBe(true)
    const stale = {
      state: 'working' as const,
      updatedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1
    }
    expect(agreed(() => isFreshNonDoneAgentStatus(stale))).toBe(false)
  })
})

describe('PRE_READY_CONTRACT', () => {
  // The rule (docs/rust-migration/ported-modules.md): the value a shim returns
  // before the core is ready must be what the deleted TypeScript would have
  // returned FOR THAT INPUT. The core is a parity port of that twin, so the
  // twin's answer is the READY answer — call each export before binding and
  // again after, and compare.
  const CONTRACT: { name: string; kind: 'parity'; why: string; call: () => unknown }[] = [
    {
      name: 'parseAgentStatusPayload',
      kind: 'parity',
      why: 'the result is persisted to last-status.json and routed by paneKey; null already means malformed, so there is no spare state for a signal',
      call: () => parseAgentStatusPayload('{"state":"waiting","prompt":"pick one"}')
    },
    {
      name: 'normalizeAgentStatusPayload',
      kind: 'parity',
      why: 'same result, same consumers — every caller writes `if (!payload) return`, so a sentinel would silently drop a real status event',
      call: () => normalizeAgentStatusPayload({ state: 'done', interrupted: true })
    },
    {
      name: 'hasUnsettledOrUnknownDispatch',
      kind: 'parity',
      why: 'a bare boolean read inside an `if` by the hibernation planner; false is the twin’s own answer for a settled dispatch',
      call: () => hasUnsettledOrUnknownDispatch({ orchestration: undefined })
    },
    {
      name: 'isFreshNonDoneAgentStatus',
      kind: 'parity',
      why: 'a bare boolean gating notifications and sidebar liveness; false is the twin’s own answer for a stale row',
      call: () =>
        isFreshNonDoneAgentStatus(
          { state: 'working', updatedAt: 1_700_000_000_000 },
          1_700_000_000_001
        )
    },
    {
      name: 'agentSubagentsEqual',
      kind: 'parity',
      why: 'a bare boolean the store reads to skip a fanout; false is the twin’s own answer for a changed list',
      call: () => agentSubagentsEqual([{ id: 'a', state: 'idle', startedAt: 1 }], undefined)
    }
  ]

  for (const row of CONTRACT) {
    it(`${row.name} is ${row.kind}: ${row.why}`, () => {
      setOrcaDispatchBinding(null)
      const preReady = row.call()
      bindWasm()
      const ready = row.call()
      expect(shapeOf(preReady)).toEqual(shapeOf(ready))
    })
  }
})
