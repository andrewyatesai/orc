// Why: computer-use has no host selector at all — the provider is chosen from
// the main process platform, so `computer click|type-text|press-key` drives the
// desktop of the machine running Orca no matter who asked. There is no such
// thing as a remote pane legitimately moving the user's mouse implicitly, and
// no object to bound the call to, so the whole group is refused for any caller
// that is not local.
import { assertLocalCallerScope, getCallerScope } from '../runtime/runtime-caller-scope'

export function assertComputerUseAllowedForCaller(action: string): void {
  assertLocalCallerScope(getCallerScope(), `computer-use (${action})`)
}
