/**
 * Raised when the SELECTED account's Codex sessions tree could not be read for a
 * reason other than a definitive absence — a briefly locked tree (antivirus,
 * backup, indexer) that `statSync`/`opendir`/`lstat` fail on with EBUSY/EPERM.
 *
 * Why a typed refusal rather than skipping: the legacy id rescan's winning home
 * becomes the resumed pane's CODEX_HOME, i.e. its account. Treating a transient
 * lock as "not bridged here" lets the scan fall through to the next ranked home,
 * so the session silently resumes under a DIFFERENT account's credentials while
 * the UI still shows the selected one (STA-4607). The PTY spawn path already
 * settles the pane reservation and rethrows on any error before spawn, so this
 * becomes a clean abort the user retries rather than a wrong-account resume.
 *
 * Fork note: upstream reuses the account-ownership gate's
 * ManagedCodexHomeTemporarilyUnavailableError for the same purpose. That gate
 * lives on the replaced Codex account surface and its typed error was never
 * adopted here, so resume provenance carries its own codex-layer refusal.
 */
export class CodexSessionResumeHomeUnavailableError extends Error {
  constructor(
    message = 'Codex account files are temporarily locked. Retry in a moment.',
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'CodexSessionResumeHomeUnavailableError'
  }
}

/** Only ENOENT/ENOTDIR mean the resume path genuinely is not bridged here; every
 *  other fs error is a transient failure that must refuse, not skip. */
export function isDefinitiveResumePathAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
