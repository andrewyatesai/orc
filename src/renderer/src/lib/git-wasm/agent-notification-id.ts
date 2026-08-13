// Agent OS-notification id derivation, driven by the Rust orca-core via the
// orca-git wasm (the shared TS impl was deleted). Both consumers already guard
// null, so a null during the ~tens-of-ms wasm boot window just transiently
// misses a dedupe/dismiss id — never a crash or a corrupted notification id.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type { BuildAgentNotificationIdArgs } from '../../../../shared/agent-notification-id'

// The payload below spells every absence as an explicit null, so the codec's
// default (reject anything JSON would mangle) applies unrelaxed.
function op(fn: string, input: unknown): unknown | null {
  if (!isGitWasmReady()) {
    return null
  }
  return dispatchToWasmCore('agent-notification-id', fn, input)
}

// Why `??` is not enough: it passes NaN through, and the codec rejects NaN rather than let it
// arrive as null. A throw here lands inside a Zustand `set()` and takes the renderer down, where
// this module already has a documented answer for unusable metadata — no id. A non-finite
// timestamp IS unusable metadata, so it takes that answer instead of the exception.
const finiteOrNull = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export function buildAgentNotificationId(args: BuildAgentNotificationIdArgs): string | null {
  // Rust null (invalid metadata) and the pre-ready null both collapse to the
  // consumers' documented "no id" case.
  const r = op('buildAgentNotificationId', {
    worktreeId: args.worktreeId ?? null,
    paneKey: args.paneKey ?? null,
    stateStartedAt: finiteOrNull(args.stateStartedAt)
  }) as string | null
  return r ?? null
}
