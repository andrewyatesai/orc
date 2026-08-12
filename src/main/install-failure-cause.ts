import {
  isWindowsSignatureCheckUnavailableFailure,
  isWindowsSignatureMismatchFailure
} from '../shared/updater-windows-signature-check'

export const INSTALL_FAILURE_CAUSE_MAX_LENGTH = 200

// Why: strip C0/DEL so a native error string can't inject terminal escapes or raw newlines into the card.
function sanitizeInstallFailureCause(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, INSTALL_FAILURE_CAUSE_MAX_LENGTH)
}

/**
 * Appends the updater's own text to the generic install-failure copy. Without it the only record of
 * why the install never started is destroyed and a remote client gets nothing but "it didn't come
 * back".
 */
export function withInstallFailureCause(baseMessage: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const cause = sanitizeInstallFailureCause(raw)
  if (!cause || cause === 'Unknown error') {
    return baseMessage
  }
  // Why: UpdateCard picks the whole card off this string, so a signature verdict must not be prefixed by contradictory restart advice.
  if (isWindowsSignatureCheckUnavailableFailure(cause) || isWindowsSignatureMismatchFailure(cause)) {
    return cause
  }
  return `${baseMessage} (${cause})`
}
