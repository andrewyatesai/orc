/**
 * Vocabulary for admitting when a PTY stop was not actually confirmed.
 *
 * `exited` requires positive evidence of absence from the owning host. Losing
 * contact with that host — an unregistered SSH provider, a dropped relay — is
 * lost contact, never a death certificate and never a successful stop. A
 * detached relay PTY is designed to outlive the provider that addressed it, so
 * "the SSH provider is no longer registered" must be reported as unconfirmed.
 */
export const SSH_PROVIDER_UNREGISTERED_REASON = 'its SSH provider is no longer registered'

/** The one sentence every surface uses to admit a stop was not confirmed. */
export function describeUnconfirmedStop(reason: string): string {
  return `The PTY was not confirmed stopped: ${reason}.`
}
