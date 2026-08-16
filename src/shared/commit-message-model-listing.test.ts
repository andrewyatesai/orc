// The model-discovery parser cases from the twin's suite, moved with the
// implementation onto the seam shim (they were `describe('model discovery
// parsers')` in src/shared/commit-message-agent-spec.test.ts; everything about
// the registry, buildArgs and the capability lookups stayed there).
//
// Every behavioural case runs TWICE — seam unbound (the shim's `parity`
// fallback: the deleted twin body, which is what any surface without a binding
// runs for the whole session) and bound to the wasm core (what main, the
// renderer and the relay run). A fallback-vs-core differential structurally
// cannot see a divergence that only appears once the seam is bound, and this
// module's one shipped bug — the JS-vs-Rust trim set on U+FEFF and U+0085 —
// was exactly that shape. These are the pre-ready contract rows for the five
// exports; the contract is `parity` for all of them, because a parsed id becomes
// the PERSISTED model selection and the next `--model` argv.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { COMMIT_MESSAGE_AGENT_SPECS } from './commit-message-agent-spec'
import {
  COMMIT_MESSAGE_MODEL_JSON_STRUCTURE_LIMITS,
  COMMIT_MESSAGE_MODEL_LISTING_FALLBACKS,
  parseAntigravityModels,
  parseCodexModels,
  parseCursorModels,
  parseLineModels,
  parsePiModels
} from './commit-message-model-listing'

const BOM = '﻿' // JS trim strips it; Rust `char::is_whitespace` does not
const NEL = '' // Rust strips it; JS trim does not
const NBSP = ' '
const LINE_SEPARATOR = ' '

function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

/** Run `call` unbound and bound; assert both equal `expected`. */
function bothStates<T>(call: () => T, expected: T): void {
  setOrcaDispatchBinding(null)
  expect(call(), 'seam UNBOUND (the shim fallback)').toEqual(expected)
  bindWasm()
  expect(call(), 'seam BOUND (the Rust core)').toEqual(expected)
}

/** Assert the shim agrees with the kept twin body in both seam states, without
 *  writing the answer down — for inputs whose answer is long or uninteresting
 *  and whose point is that the two arms cannot drift apart. */
function agreesWithFallback(
  fn: keyof typeof COMMIT_MESSAGE_MODEL_LISTING_FALLBACKS,
  stdout: string
): void {
  const shim = {
    parseCodexModels,
    parseLineModels,
    parsePiModels,
    parseCursorModels,
    parseAntigravityModels
  }[fn]
  bothStates(() => shim(stdout), COMMIT_MESSAGE_MODEL_LISTING_FALLBACKS[fn](stdout))
}

afterAll(bindWasm)

describe('model discovery parsers (moved from commit-message-agent-spec.test.ts)', () => {
  it('parses Codex model JSON', () => {
    bothStates(
      () =>
        parseCodexModels(
          JSON.stringify({
            models: [
              {
                slug: 'gpt-5.5',
                display_name: 'GPT-5.5',
                default_reasoning_level: 'low',
                supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }]
              }
            ]
          })
        ),
      [
        {
          id: 'gpt-5.5',
          label: 'GPT-5.5',
          thinkingLevels: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' }
          ],
          defaultThinkingLevel: 'low'
        }
      ]
    )
  })

  it('rejects excessive Codex model nesting', () => {
    const depth = COMMIT_MESSAGE_MODEL_JSON_STRUCTURE_LIMITS.nestingDepth + 1
    bothStates(() => parseCodexModels(`${'['.repeat(depth)}0${']'.repeat(depth)}`), [])
    bothStates(() => parseCodexModels(`${'['.repeat(depth - 2)}0${']'.repeat(depth - 2)}`), [])
  })

  // The twin asserted the budget runs BEFORE JSON.parse, which is a property of
  // the body, not of the answer. It is asserted against the kept body: with the
  // seam bound, the parse happens in Rust and `decodeDispatchResult` calls
  // JSON.parse on the RESULT, so a spy would report a call that means nothing.
  it('applies the structural budget before JSON.parse in the kept twin body', () => {
    const parseSpy = vi.spyOn(JSON, 'parse')
    const depth = COMMIT_MESSAGE_MODEL_JSON_STRUCTURE_LIMITS.nestingDepth + 1
    try {
      expect(
        COMMIT_MESSAGE_MODEL_LISTING_FALLBACKS.parseCodexModels(
          `${'['.repeat(depth)}0${']'.repeat(depth)}`
        )
      ).toEqual([])
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })

  it('parses one-model-per-line output', () => {
    bothStates(
      () => parseLineModels('opencode/gpt-5.4-mini\n\nopenai/gpt-5.5\n').map((m) => m.id),
      ['opencode/gpt-5.4-mini', 'openai/gpt-5.5']
    )
  })

  it('parses Pi model table output with provider-qualified ids', () => {
    const output = [
      'provider        model                   context  max-out  thinking  images',
      'github-copilot  gpt-5.4-mini            400K     128K     yes       yes',
      'github-copilot  gpt-4o                  128K     4.1K     no        yes'
    ].join('\n')

    bothStates(
      () => parsePiModels(output),
      [
        {
          id: 'github-copilot/gpt-5.4-mini',
          label: 'Github Copilot GPT 5.4 Mini',
          thinkingLevels: [
            { id: 'off', label: 'Off' },
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' },
            { id: 'xhigh', label: 'Extra High' }
          ],
          defaultThinkingLevel: 'low'
        },
        {
          id: 'github-copilot/gpt-4o',
          label: 'Github Copilot GPT 4O'
        }
      ]
    )
  })

  it('parses Cursor model output', () => {
    bothStates(
      () => parseCursorModels('auto - Auto\ngpt-5.2 - GPT-5.2\n'),
      [
        { id: 'auto', label: 'Auto' },
        {
          id: 'gpt-5.2',
          label: 'GPT-5.2',
          thinkingLevels: [
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' },
            { id: 'xhigh', label: 'Extra High' }
          ],
          defaultThinkingLevel: 'low'
        }
      ]
    )
  })

  it('parses Antigravity model output', () => {
    const output = [
      'Gemini 3.5 Flash (Medium)',
      'Gemini 3.5 Flash (High)',
      'Gemini 3.5 Flash (Low)',
      'Gemini 3.1 Pro (Low)',
      'Gemini 3.1 Pro (High)',
      'Claude Sonnet 4.6 (Thinking)',
      'Claude Opus 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)'
    ].join('\n')

    bothStates(
      () => parseAntigravityModels(output),
      [
        { id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' },
        { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash (High)' },
        { id: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash (Low)' },
        { id: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro (Low)' },
        { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro (High)' },
        { id: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 (Thinking)' },
        { id: 'Claude Opus 4.6 (Thinking)', label: 'Claude Opus 4.6 (Thinking)' },
        { id: 'GPT-OSS 120B (Medium)', label: 'GPT-OSS 120B (Medium)' }
      ]
    )
  })

  it('parses CRLF-heavy dynamic model outputs in both seam states', () => {
    const noise = 'ignored model with spaces\r\n'.repeat(10_000)
    const blankNoise = '\r\n'.repeat(10_000)

    bothStates(
      () => parseLineModels(`${noise}opencode/gpt-5.4-mini\r\nopenai/gpt-5.5\r\n`).map((m) => m.id),
      ['opencode/gpt-5.4-mini', 'openai/gpt-5.5']
    )
    bothStates(
      () =>
        parsePiModels(
          `${noise}provider model context max-out thinking images\r\ngithub-copilot gpt-5.4-mini 400K 128K yes yes\r\n`
        )[0]?.id,
      'github-copilot/gpt-5.4-mini'
    )
    bothStates(() => parseCursorModels(`${noise}auto - Auto\r\ngpt-5.2 - GPT-5.2\r\n`).length, 2)
    bothStates(
      () => parseAntigravityModels(`${blankNoise}Gemini 3.5 Flash (Medium)\r\n`),
      [{ id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' }]
    )
  })

  // Why still asserted: the fallback is the code every unbound surface runs, and
  // a 10,000-row listing is the input that made the twin avoid array splitting.
  it('never splits the whole listing into an array in the kept twin body', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const noise = 'ignored model with spaces\r\n'.repeat(10_000)
    try {
      COMMIT_MESSAGE_MODEL_LISTING_FALLBACKS.parseLineModels(`${noise}openai/gpt-5.5\r\n`)
      COMMIT_MESSAGE_MODEL_LISTING_FALLBACKS.parsePiModels(`${noise}a b c d yes f\r\n`)
      COMMIT_MESSAGE_MODEL_LISTING_FALLBACKS.parseCursorModels(`${noise}auto - Auto\r\n`)
      COMMIT_MESSAGE_MODEL_LISTING_FALLBACKS.parseAntigravityModels(`${noise}Gemini\r\n`)
      const usedFullLineSplit = splitSpy.mock.calls.some(
        ([separator]) =>
          (typeof separator === 'string' && separator === '\n') ||
          (separator instanceof RegExp && separator.source === '\\r?\\n')
      )
      const usedWhitespaceFieldSplit = splitSpy.mock.calls.some(
        ([separator]) => separator instanceof RegExp && separator.source === '\\s+'
      )
      expect(usedFullLineSplit).toBe(false)
      expect(usedWhitespaceFieldSplit).toBe(false)
    } finally {
      splitSpy.mockRestore()
    }
  })
})

// The class this module was refused on, twice: the port reached for
// `char::is_whitespace`/`split_whitespace` where the twin uses JS `.trim()` and
// ECMAScript `\s`. The two sets disagree on exactly two codepoints, in opposite
// directions, and the value they land in is a persisted model id.
describe('the JS trim set, on the value that becomes the persisted --model argv', () => {
  it('strips a U+FEFF the Rust whitespace set would keep', () => {
    bothStates(() => parseLineModels(`${BOM}openai/gpt-5.5${BOM}\n`)[0]?.id, 'openai/gpt-5.5')
    bothStates(
      () => parseAntigravityModels(`${BOM}Gemini 3.5 Flash (Medium)\n`)[0]?.id,
      'Gemini 3.5 Flash (Medium)'
    )
    bothStates(() => parseCursorModels(`${BOM}auto - Auto\n`)[0]?.id, 'auto')
  })

  it('KEEPS a U+0085 the Rust whitespace set would strip', () => {
    bothStates(() => parseLineModels(`${NEL}openai/gpt-5.5\n`)[0]?.id, `${NEL}openai/gpt-5.5`)
    bothStates(
      () => parseAntigravityModels(`${NEL}Gemini 3.5 Flash (Medium)\n`)[0]?.id,
      `${NEL}Gemini 3.5 Flash (Medium)`
    )
  })

  it('follows the same split for the Pi column table, which is its own code list', () => {
    // U+FEFF IS a field separator there; U+0085 is NOT.
    bothStates(() => parsePiModels(`a${BOM}b${BOM}c${BOM}d${BOM}yes${BOM}f`)[0]?.id, 'a/b')
    bothStates(() => parsePiModels(`a${NEL}b${NEL}c${NEL}d${NEL}yes${NEL}f`), [])
  })

  it('follows ECMAScript \\s and `.` for the Cursor line regex', () => {
    bothStates(() => parseCursorModels(`auto${NBSP}-${NBSP}Auto`)[0]?.id, 'auto')
    bothStates(() => parseCursorModels(`auto${BOM}-${BOM}Auto`)[0]?.id, 'auto')
    // U+0085 is Unicode White_Space but NOT ECMAScript \s, so the line does not match.
    bothStates(() => parseCursorModels(`auto${NEL}-${NEL}Auto`), [])
    // U+2028 is a LineTerminator, which JS `.` excludes (no `s` flag).
    bothStates(() => parseCursorModels(`auto - A${LINE_SEPARATOR}B`), [])
    bothStates(() => parseCursorModels(`auto - Auto${NBSP}(default)`)[0]?.label, 'Auto')
  })
})

describe('line splitting and the Codex throw order', () => {
  it('ends a line on a lone CR, not only on LF', () => {
    bothStates(() => parseLineModels('a\rb\rc').map((m) => m.id), ['a', 'b', 'c'])
    bothStates(() => parseLineModels('a\r\nb\n\rc').map((m) => m.id), ['a', 'b', 'c'])
    bothStates(() => parseAntigravityModels('a\rb').map((m) => m.id), ['a', 'b'])
  })

  it('does not treat U+2028 as a line ending', () => {
    agreesWithFallback('parseLineModels', `a${LINE_SEPARATOR}b`)
  })

  it('answers [] for every shape the twin threw on, and only those', () => {
    for (const stdout of [
      'not json',
      'null',
      '{"models":"x"}',
      '{"models":[null]}',
      '{"models":[{"slug":"a","display_name":"A","supported_reasoning_levels":"x"}]}',
      '{"models":[{"slug":"a","display_name":"A","supported_reasoning_levels":[null]}]}',
      '{"models":[{"slug":"a","display_name":"A","supported_reasoning_levels":[{"effort":7}]}]}',
      '{"models":[{"slug":"a","display_name":"A","supported_reasoning_levels":{"length":1}}]}'
    ]) {
      bothStates(() => parseCodexModels(stdout), [])
    }
    // An entry the filter DROPPED can never throw, however malformed: scanning it
    // too once turned one junk row into a wiped model list.
    bothStates(
      () =>
        parseCodexModels(
          '{"models":[{"slug":"","display_name":"X","supported_reasoning_levels":[null]},{"slug":"a","display_name":"A"}]}'
        ),
      [{ id: 'a', label: 'A' }]
    )
  })

  it('applies JS truthiness, not a typed schema, to the listing fields', () => {
    // A truthy non-string slug survives the filter and is copied through verbatim.
    agreesWithFallback('parseCodexModels', '{"models":[{"slug":5,"display_name":"X"}]}')
    agreesWithFallback('parseCodexModels', '{"models":[{"slug":"a","display_name":0}]}')
    // `?? 'low'` is NULLISH: `false` is kept, not replaced.
    agreesWithFallback(
      'parseCodexModels',
      '{"models":[{"slug":"a","display_name":"A","supported_reasoning_levels":[{"effort":"xhigh"}],"default_reasoning_level":false}]}'
    )
    // Objects compare by reference in a Set, so two equal structured ids both stay.
    agreesWithFallback(
      'parseCodexModels',
      '{"models":[{"slug":{"k":1},"display_name":"A"},{"slug":{"k":1},"display_name":"B"}]}'
    )
  })
})

describe('inputs the crossing cannot carry, answered locally', () => {
  // A lone surrogate in the raw stdout: the codec refuses to ENCODE it (Rust
  // could not parse the payload at all), and the twin parsed it fine.
  it('answers a raw lone surrogate locally instead of failing at the seam', () => {
    bothStates(() => parseLineModels('open\uD800code\n')[0]?.id, 'open\uD800code')
    bothStates(() => parseAntigravityModels('Gemini \uDC00\n')[0]?.id, 'Gemini \uDC00')
    bothStates(() => parseCursorModels('a\uD800 - B\n')[0]?.id, 'a\uD800')
    bothStates(() => parsePiModels('a\uD800 b c d yes f')[0]?.id, 'a\uD800/b')
  })

  // The OTHER surrogate hazard, and the reason parseCodexModels has a guard the
  // other four do not need: here the stdout is plain ASCII, so it encodes and
  // crosses fine — it is the PARSED value that no Rust `String` can hold, so
  // serde_json rejects the whole document. Declared in the core's own header as
  // the one residual that has to be answered at the seam.
  it('answers a Codex lone-surrogate ESCAPE locally', () => {
    bothStates(
      () => parseCodexModels('{"models":[{"slug":"a\\ud800","display_name":"A"}]}'),
      [{ id: 'a\uD800', label: 'A' }]
    )
    bothStates(
      () => parseCodexModels('{"models":[{"slug":"a","display_name":"A\\udfff"}]}'),
      [{ id: 'a', label: 'A\uDFFF' }]
    )
  })

  // The guard above is load-bearing, not defensive dressing: plant the violation
  // by asking the core the same question the shim would have asked without it,
  // and watch the answer be wrong. Delete the guard and the case above turns red.
  it('proves the Codex guard is load-bearing: the core answers [] for that input', () => {
    const stdout = '{"models":[{"slug":"a\\ud800","display_name":"A"}]}'
    expect(
      JSON.parse(orcaDispatch('commit-message-models', 'parseCodexModels', JSON.stringify(stdout)))
    ).toEqual([])
    expect(COMMIT_MESSAGE_MODEL_LISTING_FALLBACKS.parseCodexModels(stdout)).toEqual([
      { id: 'a\uD800', label: 'A' }
    ])
  })

  // The guard must not swallow the ordinary case: a matched pair is a real astral
  // character, and both arms answer it identically.
  it('leaves a matched surrogate pair answering the twin value', () => {
    bothStates(
      () => parseCodexModels('{"models":[{"slug":"a\\ud83d\\ude80","display_name":"A"}]}'),
      [{ id: 'a\u{1F680}', label: 'A' }]
    )
  })
})

// Reachability: the shipped app never imports these functions by name. It reaches
// them through `modelDiscovery.parse` on the shared spec table, which is what
// `finalizeModelDiscoveryOutput` calls on real agent-CLI stdout.
describe('the production construction path', () => {
  const ROUTED = [
    ['codex', parseCodexModels],
    ['opencode', parseLineModels],
    ['pi', parsePiModels],
    ['cursor', parseCursorModels],
    ['antigravity', parseAntigravityModels]
  ] as const

  it('points every dynamic agent spec at the shim, not at a local body', () => {
    for (const [agentId, shim] of ROUTED) {
      const spec = COMMIT_MESSAGE_AGENT_SPECS[agentId]
      expect(spec?.modelSource, agentId).toBe('dynamic')
      expect(spec?.modelDiscovery?.parse, agentId).toBe(shim)
      expect(
        Object.values(COMMIT_MESSAGE_MODEL_LISTING_FALLBACKS) as unknown[],
        `${agentId} must route through the shim, not straight to the fallback`
      ).not.toContain(spec?.modelDiscovery?.parse)
    }
  })

  it('parses through the table the way discovery does', () => {
    bothStates(
      () =>
        COMMIT_MESSAGE_AGENT_SPECS.antigravity?.modelDiscovery?.parse(
          'Gemini 3.5 Flash (Medium)\nGemini 3.5 Flash (High)\n'
        ),
      [
        { id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' },
        { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash (High)' }
      ]
    )
    bothStates(
      () =>
        COMMIT_MESSAGE_AGENT_SPECS.pi?.modelDiscovery?.parse(
          'provider model context max-out thinking images\ngithub-copilot gpt-4o 128K 4.1K no yes\n'
        ),
      [{ id: 'github-copilot/gpt-4o', label: 'Github Copilot GPT 4O' }]
    )
  })
})
