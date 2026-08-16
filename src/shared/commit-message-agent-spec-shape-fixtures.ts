// The named input cells the `commit-message-agent-spec` cutover is measured over,
// and the three answer images the measurement reports separately.
//
// SHAPE, NOT CALL COUNT. A large denominator looks exhaustive and still misses a
// whole input shape — three attempts on another module reported clean headlines
// an independent rerun refuted. So every axis below is a list of NAMED cells, the
// suites run the complete cross product of them, and what the axes do not reach
// is written down in `commit-message-agent-spec-shape-coverage.test.ts` rather
// than left implicit.
import { COMMIT_MESSAGE_AGENT_SPECS } from './commit-message-agent-spec'

export type Cell<T> = { name: string; value: T }

function cell<T>(name: string, value: T): Cell<T> {
  return { name, value }
}

/** Every model id the registry declares, so no catalog row is only sampled. */
export const CATALOG_MODEL_IDS: string[] = [
  ...new Set(
    Object.values(COMMIT_MESSAGE_AGENT_SPECS).flatMap((spec) =>
      (spec?.models ?? []).map((model) => model.id)
    )
  )
]

/** AXIS: the registry key. Four classes — registered, a TuiAgent with no
 *  commit-message spec, an unregistered string, a PROTOTYPE-CHAIN key (a raw
 *  property read answers Object.prototype's member) and a non-string the same
 *  read COERCES into one. */
export const AGENT_ID_CELLS: Cell<unknown>[] = [
  ...Object.keys(COMMIT_MESSAGE_AGENT_SPECS).map((id) => cell(`registered:${id}`, id)),
  cell('tui-agent-without-spec:grok', 'grok'),
  cell('tui-agent-without-spec:aider', 'aider'),
  cell('tui-agent-without-spec:gemini', 'gemini'),
  cell('unregistered:empty', ''),
  cell('unregistered:nope', 'nope'),
  cell('unregistered:custom-sentinel', 'custom'),
  cell('prototype-key:toString', 'toString'),
  cell('prototype-key:constructor', 'constructor'),
  cell('prototype-key:valueOf', 'valueOf'),
  cell('prototype-key:__proto__', '__proto__'),
  cell('prototype-key:hasOwnProperty', 'hasOwnProperty'),
  cell('prototype-key:isPrototypeOf', 'isPrototypeOf'),
  cell('prototype-key:propertyIsEnumerable', 'propertyIsEnumerable'),
  cell('prototype-key:toLocaleString', 'toLocaleString'),
  cell('non-string:array-coerces', ['claude']),
  cell('non-string:object', {}),
  cell('non-string:number', 5),
  cell('non-string:boolean', true),
  cell('non-string:null', null),
  cell('non-string:undefined', undefined)
]

/** AXIS: the model id. `getCommitMessageModel` reads it three ways — an `===`
 *  scan of the catalog, a `.trim()` emptiness test whose JS whitespace set
 *  differs from Rust's on U+FEFF and U+0085, and `labelFromModelId` +
 *  `withOpenAiThinking` over the raw text. */
export const MODEL_ID_CELLS: Cell<unknown>[] = [
  ...CATALOG_MODEL_IDS.map((id) => cell(`catalog:${id}`, id)),
  cell('blank:empty', ''),
  cell('blank:space', ' '),
  cell('blank:tab-lf-cr', '\t\n\r'),
  cell('blank:bom', '﻿'),
  cell('blank:nbsp', ' '),
  cell('blank:line-separator', ' '),
  cell('blank:paragraph-separator', ' '),
  cell('blank:ideographic-space', '　'),
  cell('blank:ogham-space', ' '),
  cell('not-blank-in-js:nel', ''),
  cell('not-blank-in-js:zero-width-space', '​'),
  cell('not-blank-in-js:mongolian-vowel-separator', '᠎'),
  cell('unregistered:plain', 'unknown-model'),
  cell('trim-prefixed:bom+catalog', '﻿gpt-5.5'),
  cell('trim-prefixed:nel+catalog', 'gpt-5.5'),
  cell('trim-prefixed:space+catalog', ' gpt-5.5'),
  cell('openai-family:upper', 'GPT-5.9'),
  cell('openai-family:codex-upper', 'CODEX-x'),
  cell('openai-family:gpt5-infix', 'x-gpt-5-y'),
  cell('openai-family:bare-gpt', 'gpt'),
  cell('openai-family:bare-GPT', 'GPT'),
  cell('short-numeric:1', '1'),
  cell('short-numeric:12', '12'),
  cell('short-numeric:123', '123'),
  cell('short-numeric:1234', '1234'),
  cell('short-numeric:9a', '9a'),
  cell('short-numeric:0x', '0x'),
  cell('separators:hyphen', 'a-b'),
  cell('separators:slash', 'a/b'),
  cell('separators:leading-slash', '/a'),
  cell('separators:trailing-slash', 'a/'),
  cell('separators:double-hyphen', '--'),
  cell('separators:double-slash', '//'),
  cell('separators:empty-parts', 'a--b'),
  cell('non-ascii:e-acute', 'é'),
  cell('non-ascii:sharp-s', 'ß'),
  cell('non-ascii:long-s', 'ſ'),
  cell('non-ascii:kelvin-sign', 'K'),
  cell('non-ascii:dotted-capital-i', 'İ'),
  cell('non-ascii:dotless-i', 'ı'),
  cell('non-ascii:fullwidth-a', 'ａ'),
  cell('non-ascii:roman-numeral', 'Ⅻ'),
  cell('non-ascii:combining-first', '́a'),
  cell('astral:deseret-small', '𐐨'),
  cell('astral:math-digit', '𝟚𝟚'),
  cell('astral:emoji', '🚀'),
  cell('astral:emoji-in-catalog-id', 'gpt-5.5🚀'),
  cell('surrogate:lone-high', '\ud800x'),
  cell('surrogate:lone-low', 'x\udc00'),
  cell('surrogate:escape-text', '\\ud800'),
  cell('spaces-inside:one', 'a b'),
  cell('spaces-inside:two', 'x  y'),
  cell('spaces-inside:catalog-like', 'Gemini 3.5 Flash (Other)'),
  cell('non-string:number', 5),
  cell('non-string:null', null),
  cell('non-string:undefined', undefined),
  cell('non-string:array', ['sonnet']),
  cell('non-string:object', {})
]

/** AXIS: composed model ids. A single atom exercises one branch of
 *  `labelFromModelId`; the label is built by SPLITTING on `/` and `-`, so the
 *  branch interactions only show up when an atom sits beside a separator, an
 *  empty part or an OpenAI-family marker. Every string cell above is glued to
 *  each affix on both sides. */
export const COMPOSED_MODEL_ID_CELLS: Cell<string>[] = (() => {
  const affixes = ['', '-', '/', 'gpt-5', 'x', '--']
  const seen = new Set<string>()
  const composed: Cell<string>[] = []
  for (const base of MODEL_ID_CELLS) {
    if (typeof base.value !== 'string') {
      continue
    }
    for (const affix of affixes) {
      for (const [name, text] of [
        [`${base.name}+suffix(${JSON.stringify(affix)})`, base.value + affix],
        [`prefix(${JSON.stringify(affix)})+${base.name}`, affix + base.value]
      ] as [string, string][]) {
        if (!seen.has(text)) {
          seen.add(text)
          composed.push(cell(name, text))
        }
      }
    }
  }
  return composed
})()

/** AXIS: the disabled roster. The twin only ever narrowed it with
 *  `Array.isArray`, so a Set and a string disable NOTHING. */
export const DISABLED_CELLS: Cell<unknown>[] = [
  cell('absent', undefined),
  cell('null', null),
  cell('empty-array', []),
  cell('disables-claude', ['claude']),
  cell('disables-codex', ['codex']),
  cell('disables-both', ['claude', 'codex']),
  cell('disables-every-catalog-agent', [
    'claude',
    'codex',
    'opencode',
    'pi',
    'amp',
    'cursor',
    'kimi',
    'copilot',
    'antigravity',
    'grok',
    'aider',
    'gemini'
  ]),
  cell('unknown-id', ['bogus']),
  cell('number-entry', [5]),
  cell('mixed-entries', ['claude', 5]),
  cell('null-entry', [null]),
  cell('object-entry', [{}]),
  cell('nested-array-entry', [['claude']]),
  cell('set-iterable', new Set(['claude'])),
  cell('string-iterable', 'claude'),
  cell('non-iterable-object', { claude: true })
]

/** AXIS: the configured Source Control AI agent, read off persisted settings. */
export const CONFIGURED_AGENT_CELLS: Cell<unknown>[] = [
  cell('absent', undefined),
  cell('null', null),
  cell('empty', ''),
  cell('registered', 'claude'),
  cell('custom-sentinel', 'custom'),
  cell('tui-agent-without-spec', 'grok'),
  cell('unregistered', 'nope'),
  cell('prototype-key', 'toString'),
  cell('non-string:number', 5),
  cell('non-string:boolean', true),
  cell('non-string:array', ['claude']),
  cell('non-string:object', {})
]

/** AXIS: `settings.defaultTuiAgent`, already collapsed to a built-in. */
export const DEFAULT_AGENT_CELLS: Cell<unknown>[] = [
  cell('absent', undefined),
  cell('null', null),
  cell('empty', ''),
  cell('blank-preference', 'blank'),
  cell('registered:claude', 'claude'),
  cell('registered:codex', 'codex'),
  cell('tui-agent-without-spec', 'grok'),
  cell('unregistered', 'nope'),
  cell('prototype-key', 'toString'),
  cell('non-string:number', 5),
  cell('non-string:boolean', true),
  cell('non-string:array', ['codex']),
  cell('non-string:object', {})
]

/** AXIS: the argument of `isCustomAgentId`. */
export const CUSTOM_SENTINEL_CELLS: Cell<unknown>[] = [
  cell('absent', undefined),
  cell('null', null),
  cell('exact', 'custom'),
  cell('upper', 'CUSTOM'),
  cell('capitalized', 'Custom'),
  cell('leading-space', ' custom'),
  cell('trailing-space', 'custom '),
  cell('empty', ''),
  cell('registered-agent', 'claude'),
  cell('number', 5),
  cell('zero', 0),
  cell('true', true),
  cell('false', false),
  cell('array', ['custom']),
  cell('object', {}),
  cell('lone-surrogate', '\ud800')
]

/** AXIS: raw agent-CLI stdout. It never reaches the seven routed lookups — it
 *  reaches `modelDiscovery.parse`, the field the UNROUTED
 *  `getCommitMessageAgentSpec` hands out — so the suites run it through the
 *  registry to prove the accessor that stays in TypeScript still delivers the
 *  Rust-backed parser for every dynamic agent. */
export const DISCOVERY_STDOUT_CELLS: Cell<string>[] = [
  cell('empty', ''),
  cell('single-newline', '\n'),
  cell('blank-lines', 'a\n\n\nb\n'),
  cell('lf', 'alpha\nbeta'),
  cell('crlf', 'alpha\r\nbeta'),
  cell('lone-cr', 'alpha\rbeta'),
  cell('trailing-crlf', 'alpha\r\n'),
  cell('indented', '    alpha\n\tbeta'),
  cell('duplicate-ids', 'dup\ndup\ndup'),
  cell('bom-prefixed', '﻿alpha'),
  cell('nel-prefixed', 'alpha'),
  cell('ansi-coloured', '[32malpha[0m'),
  cell('non-ascii', 'héllo-mødel'),
  cell('astral', '🚀-model'),
  cell('whitespace-only', '   \t  '),
  cell('spaces-in-id', 'alpha beta'),
  cell('pi-table-header', 'provider model ctx cost thinking extra'),
  cell('pi-table-row', 'openai gpt-5.5 200k 1.00 yes extra'),
  cell('cursor-row', 'gpt-5.5 - GPT 5.5 (default)'),
  cell('codex-json', '{"models":[{"slug":"gpt-5.5","display_name":"GPT-5.5"}]}'),
  cell('codex-json-broken', '{"models":['),
  cell('codex-json-surrogate-escape', '{"models":[{"slug":"\\ud800","display_name":"x"}]}')
]

// --- the three answer images ---

/** What a thrown answer looks like, so a crash compares like any other answer. */
export function callImage(call: () => unknown): { ok: boolean; value: unknown; thrown: string } {
  try {
    return { ok: true, value: call(), thrown: '' }
  } catch (error) {
    return {
      ok: false,
      value: undefined,
      thrown: `${(error as Error).name}: ${(error as Error).message}`
    }
  }
}

/** BYTE — `JSON.stringify`. Key ORDER counts; own-`undefined` is dropped. */
export function byteImage(answer: ReturnType<typeof callImage>): string {
  return answer.ok ? (JSON.stringify(answer.value) ?? 'undefined') : `THREW ${answer.thrown}`
}

/** VALUE — keys sorted, own-`undefined` dropped. What every `?.` read, every
 *  by-key consumer and every JSON round trip sees. */
export function valueImage(answer: ReturnType<typeof callImage>): string {
  return answer.ok ? sortedJson(answer.value) : `THREW ${answer.thrown}`
}

/** STRICT — key order counts AND an own property holding `undefined` is
 *  distinguished from an absent one. The only image that can see either class. */
export function strictImage(answer: ReturnType<typeof callImage>): string {
  return answer.ok ? strictJson(answer.value) : `THREW ${answer.thrown}`
}

function sortedJson(value: unknown): string {
  if (value === undefined) {
    return 'undefined'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(sortedJson).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${sortedJson(member)}`)
  return `{${entries.join(',')}}`
}

function strictJson(value: unknown): string {
  if (value === undefined) {
    return 'undefined'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(strictJson).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([key, member]) => `${JSON.stringify(key)}:${strictJson(member)}`
  )
  return `{${entries.join(',')}}`
}
