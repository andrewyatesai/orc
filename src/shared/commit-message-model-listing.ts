// Agent-CLI model-discovery parsing on the Rust `orca_agents::commit_message_models`
// core. The twin (`src/shared/commit-message-agent-spec.ts`) keeps its types, the
// agent registry, the capability lookups and its own `labelFromModelId` import;
// the five listing parsers it used to hold are DELETED, and every
// `modelDiscovery.parse` field in that table points here.
//
// ON THE SHARED DISPATCH SEAM, not a surface binding, because the parsers are
// reached through a DATA FIELD of a `src/shared` table: every surface that
// imports COMMIT_MESSAGE_AGENT_SPECS carries `modelDiscovery.parse` on it, so the
// reference has to resolve in main/cli (napi), the renderer and the relay (wasm)
// alike. Only main calls it today — `finalizeModelDiscoveryOutput` in
// `src/main/text-generation/commit-message-text-generation.ts`, reached from both
// the local and the SSH-remote discovery paths.
//
// WHY THE OPENAI EFFORT TABLE LIVES HERE. `withOpenAiThinking` is needed by both
// halves — the parsers mint it per discovered id, the static catalog rows spread
// it — and the twin already imports this module for the parsers, so keeping it
// there would make a VALUE cycle between two `src/shared` modules (the hazard
// that made the last one need a deferred call). `labelFromModelId` does NOT move:
// it already sits in its own leaf, `./model-id-label`, which both halves and
// `grok-model-list-probe.ts` import.
//
// PRE-READY CONTRACT — `parity`, and it is FORCED rather than chosen:
//   * No plausible constant exists. A parsed `id` becomes the PERSISTED model
//     selection (`selectedModelByAgentByHost`) and the `--model` argv of the next
//     agent spawn. `[]` is not neutral either: it is this CLI's "listed nothing",
//     which `finalizeModelDiscoveryOutput` converts into the STATIC catalog and a
//     different model than the user picked.
//   * No sentinel is available. The return type is a plain list and the sole
//     caller already branches on `.length === 0`, so a third state has nowhere to
//     live without widening `CommitMessageAgentSpec['modelDiscovery']['parse']` —
//     a field `grok-model-list-probe.ts` also fills with a non-shim parser.
// So the fallback is the deleted twin's own body over the constants that stayed
// in TypeScript, which makes pre-ready equal ready for EVERY input, and
// `tools/parity/dispatch/commit-message-models.ts` re-checks that on every vector.
//
// MEASURED, NOT ASSUMED. The corpus is 40,068 inputs — 68 hand-built probes over
// raw agent-CLI stdout, one per divergence class an audit has actually found (the
// JS-vs-Rust trim set on U+FEFF/U+0085, CR/CRLF/lone-CR splitting, the Pi column
// whitespace table, the Cursor regex under ECMAScript `\s` and `.`, the Codex
// throw order and JS-truthiness shapes, labelFromModelId's UTF-16 counting), plus
// 40,000 randomised listings over a 40-atom hazard alphabet. It was run twice:
//   * against the CORES directly, 40,064 crossings each (4 inputs the codec
//     refuses to encode) on the renderer/relay wasm blob and on the main/cli napi
//     addon. Exactly two inputs diverged from the twin, both the Codex
//     lone-surrogate escape `orca_agents::commit_message_models` hands back to
//     this seam in its own header. They are answered locally below.
//   * against THIS module, 40,068 in each of three seam states (unbound, bound to
//     wasm, bound to napi) = 120,204 comparisons, zero divergences — the leg that
//     covers the guard, and the only one that can see a bound-only difference.
// Both runs carry a planted control the harness must catch, because three probes
// this session passed against unfixed cores by being malformed.
// `commit-message-model-listing.test.ts` pins every class in both seam states,
// and the 113 vectors in `tools/parity/vectors/commit-message-models.json` (17
// before this cutover) re-check them on every `pnpm parity`.
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { DispatchPayloadError } from './dispatch-payload-codec'
import { labelFromModelId } from './model-id-label'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import type { CommitMessageModel, ThinkingLevel } from './commit-message-agent-spec'

const COMMIT_MESSAGE_MODELS = 'commit-message-models'

/** Structural budget applied to `codex debug models` output BEFORE JSON.parse. */
export const COMMIT_MESSAGE_MODEL_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 64 * 1024,
  nestingDepth: 16
} as const

export const OPENAI_THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' }
]

/** OpenAI-family ids expose the standard effort levels; everything else omits
 *  both keys so the UI hides the dropdown. */
export function withOpenAiThinking(
  id: string
): Pick<CommitMessageModel, 'thinkingLevels' | 'defaultThinkingLevel'> {
  return /(?:gpt-5|codex)/i.test(id)
    ? { thinkingLevels: OPENAI_THINKING_LEVELS, defaultThinkingLevel: 'low' }
    : {}
}

// --- the deleted twin bodies, verbatim: the pre-ready answer and the
// --- out-of-representation answer, never a second implementation ---

function uniqueModels(models: CommitMessageModel[]): CommitMessageModel[] {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) {
      return false
    }
    seen.add(model.id)
    return true
  })
}

function* iterateModelOutputLines(output: string): Generator<string> {
  let lineStart = 0

  for (let index = 0; index < output.length; index++) {
    const code = output.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      continue
    }

    yield output.slice(lineStart, index)
    if (code === 13 && output.charCodeAt(index + 1) === 10) {
      index++
    }
    lineStart = index + 1
  }

  if (lineStart <= output.length) {
    yield output.slice(lineStart)
  }
}

function isPiModelTableWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

// Why: model discovery output can include paste-sized noisy lines; only the first fields matter.
function getPiModelTableFields(line: string, maxFields: number): string[] {
  const fields: string[] = []
  let tokenStart = -1

  for (let index = 0; index <= line.length; index += 1) {
    const isEnd = index === line.length
    if (!isEnd && !isPiModelTableWhitespace(line.charCodeAt(index))) {
      if (tokenStart === -1) {
        tokenStart = index
      }
      continue
    }
    if (tokenStart !== -1) {
      fields.push(line.slice(tokenStart, index))
      tokenStart = -1
      if (fields.length >= maxFields) {
        break
      }
    }
  }

  return fields
}

function localCodexModels(stdout: string): CommitMessageModel[] {
  try {
    assertJsonTextStructureWithinLimits(stdout, COMMIT_MESSAGE_MODEL_JSON_STRUCTURE_LIMITS)
    const parsed = JSON.parse(stdout) as {
      models?: {
        slug?: string
        display_name?: string
        supported_reasoning_levels?: { effort?: string }[]
        default_reasoning_level?: string
      }[]
    }
    return uniqueModels(
      (parsed.models ?? [])
        .filter((model) => model.slug && model.display_name)
        .map((model) => ({
          id: model.slug!,
          label: model.display_name!,
          ...(model.supported_reasoning_levels?.length
            ? {
                thinkingLevels: model.supported_reasoning_levels
                  .map((level) => level.effort)
                  .filter((effort): effort is string => Boolean(effort))
                  .map((effort) => ({
                    id: effort,
                    label: effort === 'xhigh' ? 'Extra High' : labelFromModelId(effort)
                  })),
                defaultThinkingLevel: model.default_reasoning_level ?? 'low'
              }
            : {})
        }))
    )
  } catch {
    return []
  }
}

function localLineModels(stdout: string): CommitMessageModel[] {
  const models: CommitMessageModel[] = []
  for (const rawLine of iterateModelOutputLines(stdout)) {
    const id = rawLine.trim()
    if (id.length === 0 || id.includes(' ')) {
      continue
    }
    models.push({ id, label: labelFromModelId(id), ...withOpenAiThinking(id) })
  }
  return uniqueModels(models)
}

function localPiModels(stdout: string): CommitMessageModel[] {
  const models: CommitMessageModel[] = []
  for (const rawLine of iterateModelOutputLines(stdout)) {
    const parts = getPiModelTableFields(rawLine, 6)
    if (parts.length < 6 || parts[0] === 'provider') {
      continue
    }

    const [provider, model, , , thinking] = parts
    models.push({
      id: `${provider}/${model}`,
      label: `${labelFromModelId(provider)} ${labelFromModelId(model)}`,
      ...(thinking === 'yes'
        ? {
            thinkingLevels: [
              { id: 'off', label: 'Off' },
              { id: 'low', label: 'Low' },
              { id: 'medium', label: 'Medium' },
              { id: 'high', label: 'High' },
              { id: 'xhigh', label: 'Extra High' }
            ],
            defaultThinkingLevel: 'low'
          }
        : {})
    })
  }
  return uniqueModels(models)
}

function localCursorModels(stdout: string): CommitMessageModel[] {
  const models: CommitMessageModel[] = []
  for (const rawLine of iterateModelOutputLines(stdout)) {
    const match = /^([^\s]+)\s+-\s+(.+)$/.exec(rawLine.trim())
    if (!match) {
      continue
    }
    models.push({
      id: match[1],
      label: match[2].replace(/\s+\((?:default|current)\)$/i, ''),
      ...withOpenAiThinking(match[1])
    })
  }
  return uniqueModels(models)
}

function localAntigravityModels(stdout: string): CommitMessageModel[] {
  const models: CommitMessageModel[] = []
  for (const rawLine of iterateModelOutputLines(stdout)) {
    const id = rawLine.trim()
    if (id.length === 0) {
      continue
    }
    models.push({ id, label: id })
  }
  return uniqueModels(models)
}

// --- the crossing ---

/** `null` from the seam means UNBOUND, never a real answer: every parser returns
 *  a list, so there is nothing to confuse it with. */
function parseModelListing(
  fn: string,
  stdout: string,
  local: (stdout: string) => CommitMessageModel[]
): CommitMessageModel[] {
  let answer: unknown
  try {
    answer = tryOrcaDispatch(COMMIT_MESSAGE_MODELS, fn, stdout, { root: 'stdout' })
  } catch (error) {
    // Why the catch: this is raw CLI stdout arriving over IPC and the SSH relay,
    // so it can hold a lone UTF-16 surrogate that no Rust `String` can carry and
    // the codec refuses to encode. The twin parsed those. A DispatchCoreError
    // (unknown module/function) is a wiring bug and still throws.
    if (error instanceof DispatchPayloadError) {
      return local(stdout)
    }
    throw error
  }
  return answer === null ? local(stdout) : (answer as CommitMessageModel[])
}

/** A `\uD800`-class ESCAPE — the six ASCII characters, not a surrogate code unit.
 *  Same shape as the codec's own hazard regex, applied to the Codex payload for
 *  the opposite reason: these characters ENCODE fine (the stdout is plain ASCII,
 *  so `DispatchPayloadError` never fires), JS `JSON.parse` accepts them and yields
 *  a string no Rust `String` can hold, so `serde_json` rejects the whole document
 *  and the core answers `[]` where the twin answered a model. Measured on both
 *  shipped artifacts; `orca_agents::commit_message_models` documents it as the one
 *  residual that "has to be answered locally at the seam". A matched pair
 *  (`🚀`) matches this test too and is also answered locally — the local
 *  path IS the twin's body, so that costs a crossing, never an answer. */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F]/

export function parseCodexModels(stdout: string): CommitMessageModel[] {
  if (SURROGATE_ESCAPE.test(stdout)) {
    return localCodexModels(stdout)
  }
  return parseModelListing('parseCodexModels', stdout, localCodexModels)
}

export function parseLineModels(stdout: string): CommitMessageModel[] {
  return parseModelListing('parseLineModels', stdout, localLineModels)
}

export function parsePiModels(stdout: string): CommitMessageModel[] {
  return parseModelListing('parsePiModels', stdout, localPiModels)
}

export function parseCursorModels(stdout: string): CommitMessageModel[] {
  return parseModelListing('parseCursorModels', stdout, localCursorModels)
}

export function parseAntigravityModels(stdout: string): CommitMessageModel[] {
  return parseModelListing('parseAntigravityModels', stdout, localAntigravityModels)
}

/** The deleted twin bodies, exported for the suite that has to compare pre-ready
 *  against ready without reaching through the seam to do it. */
export const COMMIT_MESSAGE_MODEL_LISTING_FALLBACKS = {
  parseCodexModels: localCodexModels,
  parseLineModels: localLineModels,
  parsePiModels: localPiModels,
  parseCursorModels: localCursorModels,
  parseAntigravityModels: localAntigravityModels
} as const
