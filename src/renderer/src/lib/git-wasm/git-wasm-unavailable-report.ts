import { toast } from 'sonner'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { track } from '@/lib/telemetry'
import { translate } from '@/i18n/i18n'
import { classifyGitWasmLoadFailure } from '../../../../shared/fork-reliability-telemetry'
import { markGitWasmUnavailable } from './git-wasm-availability'

// Why a module of its own rather than living in git-line-stats: `track` comes
// from lib/telemetry, which re-exports the agent-kind shim and so imports
// git-line-stats back. Only the two boot entries (the startup gate and the web
// entry) import this, so nothing imports it in a cycle.

let reported = false

/**
 * The single place a terminal orca-git wasm load failure becomes visible.
 *
 * Boot deliberately continues — the first paint is an empty shell that needs no
 * wasm, and diverting hydration into recovery would trade "quietly does less"
 * for a white screen. What must NOT continue is the silence: without this the
 * error object was discarded and every `git-wasm/*` shim returned its
 * null/identity fallback for the rest of the session with nothing recorded
 * anywhere.
 *
 * Idempotent: the desktop entry, the startup gate, and the web entry can all
 * observe the same memoized rejection, and the user must see it once.
 */
export function reportGitWasmUnavailable(error: unknown): void {
  markGitWasmUnavailable(error)
  if (reported) {
    return
  }
  reported = true

  const errorClass = classifyGitWasmLoadFailure(error)
  console.error(
    '[git-wasm] orca-git core failed to load; renderer helpers are on their null fallbacks',
    { errorClass },
    error
  )
  recordRendererCrashBreadcrumb('git_wasm_unavailable', { error_class: errorClass })
  track('git_wasm_unavailable', { error_class: errorClass })

  // Why a single persistent toast and not a dialog: the app is usable and no
  // decision is being demanded, but the degradation outlives a 4-second toast —
  // so it stays until dismissed (the app Toaster mounts with `closeButton`).
  toast.error(translate('app.gitWasmUnavailable.title', 'Orca is running with reduced features.'), {
    id: 'git-wasm-unavailable',
    duration: Number.POSITIVE_INFINITY,
    description: translate(
      'app.gitWasmUnavailable.description',
      'The Git engine could not load, so workspace names, repo icons, and diff line counts fall back to basic values. Relaunch Orca to try again.'
    )
  })
}

export function _resetGitWasmUnavailableReportForTests(): void {
  reported = false
}
