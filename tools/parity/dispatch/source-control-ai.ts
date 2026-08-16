// TS dispatch for the source-control-ai parity module: maps the shared vector
// function names to the real TypeScript reference so the harness compares it
// against the Rust port.
//
// `src/shared/source-control-ai.ts` was CUT OVER in place — same path, same
// exports, dispatch bodies — so this import line did not change and this adapter
// now drives the SHIM, like the feature-tips and wsl-paths adapters.
// `config/vitest.parity.config.ts` installs no setup file, so the seam is UNBOUND
// here and the shim answers from its `parity` fallback: exactly the deleted-twin
// bodies in `source-control-ai-{settings-normalization,operation-precedence,…}.ts`,
// and exactly what a surface runs before (or without) a binding. Importing those
// modules directly instead would test the same code while hiding a shim that
// stopped calling them; going through the shim keeps this a real TS-vs-Rust
// differential either way.
//
// Two argument encodings are in play, and both are MEASURED by
// `pnpm parity:twin-derived` (phase A replays these cases), not chosen freely:
// a single-parameter export takes the vector `input` as that argument, and a
// multi-parameter export takes a named-argument object keyed by the twin's own
// parameter names.
//
// No `?? null` on the undefined-returning exports: the recorder compares a
// twin's RAW return against what this adapter reports, so coercing `undefined`
// to `null` here would mark those functions underivable and drop every case
// they could contribute. Inputs whose twin answer is `undefined` are covered in
// the Rust crate's test port instead.

import {
  clearSourceControlAiModelChoiceForHost,
  getDefaultSourceControlAiSettings,
  hasConfiguredSourceControlAiInstructions,
  mergeLegacyCommitMessageAiIntoSourceControlAi,
  normalizeRepoSourceControlAiOverrides,
  normalizeSourceControlAiSettings,
  projectSourceControlAiToLegacyCommitMessageAi,
  readSourceControlAiModelChoiceForHost,
  resolveSourceControlActionRecipe,
  resolveSourceControlAiEnabled,
  resolveSourceControlAiForOperation,
  resolveSourceControlAiInstructions,
  resolveSourceControlAiPrCreationDefaults,
  selectSourceControlAiModelChoiceForHost,
  sourceControlAiSettingsFromLegacy
} from '../../../src/shared/source-control-ai'

/* eslint-disable @typescript-eslint/no-explicit-any -- Why: a vector input is
   untyped JSON by construction; the twin's own runtime guards are the subject
   of the comparison, so the adapter must hand values over unnarrowed. */
type Args = Record<string, any>

/** Named-argument object -> positional call, with TRAILING ABSENT ARGUMENTS
 *  DROPPED rather than passed as `undefined`.
 *
 *  Not cosmetic: the recorder writes each call's args as JSON, where a trailing
 *  `undefined` becomes `null`, and the convention check then compares `null`
 *  against the vector's absent key and concludes neither encoding fits. Padding
 *  the call marked `normalizeSourceControlAiSettings`,
 *  `mergeLegacyCommitMessageAiIntoSourceControlAi` and
 *  `projectSourceControlAiToLegacyCommitMessageAi` UNDERIVABLE, which silently
 *  drops every case the twin's own tests could contribute for them. */
function positional(args: Args, names: string[]): any[] {
  const values = names.map((name) => args[name])
  while (values.length > 0 && !(names[values.length - 1] in args)) {
    values.pop()
  }
  return values
}

export function dispatch(fn: string, input: unknown): unknown {
  const args = (input ?? {}) as Args
  switch (fn) {
    case 'normalizeRepoSourceControlAiOverrides':
      return normalizeRepoSourceControlAiOverrides(input)
    case 'getDefaultSourceControlAiSettings':
      return getDefaultSourceControlAiSettings()
    case 'sourceControlAiSettingsFromLegacy':
      return sourceControlAiSettingsFromLegacy(input as any)
    case 'normalizeSourceControlAiSettings':
      return (normalizeSourceControlAiSettings as any)(...positional(args, ['value', 'legacy']))
    case 'mergeLegacyCommitMessageAiIntoSourceControlAi':
      return (mergeLegacyCommitMessageAiIntoSourceControlAi as any)(
        ...positional(args, ['sourceControlAi', 'legacy', 'options'])
      )
    case 'projectSourceControlAiToLegacyCommitMessageAi':
      return (projectSourceControlAiToLegacyCommitMessageAi as any)(
        ...positional(args, ['sourceControlAi', 'previousLegacy'])
      )
    case 'readSourceControlAiModelChoiceForHost':
      return (readSourceControlAiModelChoiceForHost as any)(
        ...positional(args, ['choice', 'hostKey', 'agentId'])
      )
    case 'selectSourceControlAiModelChoiceForHost':
      return (selectSourceControlAiModelChoiceForHost as any)(
        ...positional(args, ['choice', 'hostKey', 'agentId', 'modelId'])
      )
    case 'clearSourceControlAiModelChoiceForHost':
      return (clearSourceControlAiModelChoiceForHost as any)(
        ...positional(args, ['choice', 'hostKey', 'agentId'])
      )
    case 'resolveSourceControlAiInstructions':
      return resolveSourceControlAiInstructions(input as any)
    case 'hasConfiguredSourceControlAiInstructions':
      return hasConfiguredSourceControlAiInstructions(input as any)
    case 'resolveSourceControlAiPrCreationDefaults':
      return resolveSourceControlAiPrCreationDefaults(input as any)
    case 'resolveSourceControlAiEnabled':
      return resolveSourceControlAiEnabled(input as any)
    case 'resolveSourceControlActionRecipe':
      return resolveSourceControlActionRecipe(input as any)
    case 'resolveSourceControlAiForOperation':
      return resolveSourceControlAiForOperation(input as any)
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
