// Agent OS-notification id derivation, driven by the Rust orca-core via the orca-git wasm.
// The shared TS impl was deleted; src/shared/agent-notification-id.ts keeps only the arg type.
//
// PRE-READY = null, and it is a SENTINEL, not parity: for valid metadata the deleted TS
// returned an id string, so null is "ask again", never an answer. Both consumers branch on it
// and neither writes it anywhere. `use-notification-dispatch` spreads
// `...(notificationId ? {notificationId} : {})`, so main shows the notification but does not
// register it in `activeNotificationsById` (no dedupe/dismiss handle); `ui.ts`'s
// `acknowledgeAgents` does `if (id) {ids.add(id)}`, so nothing is queued for dismissal.
// Assume the terminal case (`isGitWasmUnavailable`), not a boot blip: for that whole session
// agent notifications still fire, they just can't be auto-dismissed on acknowledgement.
// Rust's own null (unusable metadata) collapses into the same branch, which is why the two
// being indistinguishable here is harmless — no id is ever fabricated, and none is persisted.
import { isGitWasmReady } from './git-line-stats'
import { dispatchToWasmCore } from './wasm-core-dispatch'
import type { BuildAgentNotificationIdArgs } from '../../../../shared/agent-notification-id'

// Why: the codec rejects NaN/±Infinity/-0, and that throw lands inside `acknowledgeAgents`'
// Zustand `set()` — a renderer crash where this module already answers "no id" for unusable
// metadata. Truncating here too because Rust's f64 Display renders `Math.trunc(-0.5)` as
// `-0` where the deleted TS's `String(Math.trunc(x))` rendered `0`.
function dispatchableStateStartedAt(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  const truncated = Math.trunc(value)
  return truncated === 0 ? 0 : truncated
}

export function buildAgentNotificationId(args: BuildAgentNotificationIdArgs): string | null {
  if (!isGitWasmReady()) {
    return null
  }
  // Every absence is spelled as an explicit null so the codec's default (reject anything
  // JSON would mangle, including a dropped `undefined` key) applies unrelaxed.
  return dispatchToWasmCore('agent-notification-id', 'buildAgentNotificationId', {
    worktreeId: args.worktreeId ?? null,
    paneKey: args.paneKey ?? null,
    stateStartedAt: dispatchableStateStartedAt(args.stateStartedAt)
  }) as string | null
}
