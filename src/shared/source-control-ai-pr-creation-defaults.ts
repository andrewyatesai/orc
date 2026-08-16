// The product PR-creation defaults, in their own module so the deleted-twin
// bodies can read them without importing `source-control-ai.ts`. That file is now
// the dispatch shim and imports those bodies, so keeping the constant there would
// make the cycle a RUNTIME one (a `const`, not a hoisted function) instead of the
// type-only cycle the rest of the split has.
import type { SourceControlAiPrCreationDefaults } from './source-control-ai-types'

export const DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS: Required<SourceControlAiPrCreationDefaults> =
  {
    draft: false,
    useTemplate: false,
    generateDetailsOnOpen: false,
    openAfterCreate: false
  }
