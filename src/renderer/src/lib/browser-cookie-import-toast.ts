import { toast } from 'sonner'
import type { BrowserCookieImportSummary } from '../../../shared/types'
import { isHandledWireDiscriminant } from '../../../shared/handled-wire-discriminant'
import { translate } from '@/i18n/i18n'

type CookieImportWarning = NonNullable<BrowserCookieImportSummary['warning']>
type CookieImportWarningCode = CookieImportWarning['code']

// Why: the summary is cast, not decoded, off the runtime RPC wire, so a newer host can send a code
// this build has never heard of. The Record key is the union itself, so a new member fails typecheck
// here instead of silently falling out of the switch into a blank toast.warning(undefined) (#15002).
const HANDLED_WARNING_CODES: Record<CookieImportWarningCode, true> = {
  'restart-fallback-unavailable': true
}

function formatCookieImportWarning(warning: CookieImportWarning): string {
  if (!isHandledWireDiscriminant(warning.code, HANDLED_WARNING_CODES)) {
    return translate(
      'auto.lib.browser.cookie.import.toast.unrecognizedWarning',
      'The cookie import finished with a warning this version of Orca does not recognize. Update Orca to see the details, then check this profile before relying on its cookies.'
    )
  }
  switch (warning.code) {
    case 'restart-fallback-unavailable':
      return warning.loadedCookies === 0
        ? translate(
            'auto.lib.browser.cookie.import.toast.restartFallbackUnavailableNone',
            'None of the {{value0}} cookies could be loaded, and the restart fallback was unavailable. The previous cookies for this profile were replaced. Try the import again.',
            { value0: warning.failedCookies }
          )
        : translate(
            'auto.lib.browser.cookie.import.toast.restartFallbackUnavailablePartial',
            'Imported {{value0}} of {{value1}} cookies. The rest could not be loaded, and the restart fallback was unavailable. Try the import again.',
            {
              value0: warning.loadedCookies,
              value1: warning.loadedCookies + warning.failedCookies
            }
          )
  }
}

// Why: Google source-bound cookies never transplant, so a degraded-but-ok import must still steer the
// user to sign in — naming the execution host so the guidance points at the right machine over SSH/remote.
function emitGoogleCookieImportWarning(
  summary: BrowserCookieImportSummary,
  executionHostLabel: string
): void {
  if (!summary.googleCookiesSkipped) {
    return
  }
  toast.warning(
    translate(
      'auto.lib.browser.cookie.import.toast.googleCookiesSkipped',
      'Google cookies were not imported. Open a browser in Orca on {{value0}} with this profile, then sign into Google.',
      { value0: executionHostLabel }
    ),
    { duration: 12000 }
  )
}

// Why: a degraded import returns ok:true with a warning, so every call site must route it to a
// warning toast instead of reporting an unqualified success (#9355).
export function emitBrowserCookieImportToast(
  summary: BrowserCookieImportSummary,
  successMessage: string,
  executionHostLabel: string
): void {
  const warning = summary.warning
  if (warning) {
    toast.warning(formatCookieImportWarning(warning))
  } else {
    toast.success(successMessage)
  }
  emitGoogleCookieImportWarning(summary, executionHostLabel)
}
