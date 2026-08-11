// Type-only, so this stays a compile-time reference and creates no import cycle with the envelope
// module, which imports `allowsPlaintextE2EEIdentity` from here.
import type { E2EEKeychainContext } from './e2ee-identity-envelope'
import { SECRET_PASSPHRASE_FILE_ENV } from '../passphrase-sealed-secret'

/**
 * May this desktop keep its mobile E2EE identity on disk in cleartext when the OS keychain cannot
 * seal it?
 *
 * This is deliberately a DIFFERENT answer from `allowsPlaintextPersistedSecret`
 * (src/main/plaintext-secret-policy.ts), and the difference is argued from what the secret is:
 *
 *   * A Jira / Linear / speech API token is RE-ACQUIRABLE. Refusing to persist it costs one
 *     re-login, the running session keeps working, and the user is told why. Refusal is right there.
 *   * This key is a DURABLE IDENTITY, not a credential. The paired phone stores our public half
 *     (mobile/src/transport/host-store.ts) and the relay derives our host address from it
 *     (`deriveRelayHostId`, src/main/runtime/relay/relay-http-client.ts). Refusing to persist it does
 *     not cost a re-login: `resolveE2EEIdentity` mints a *different* identity on the next launch, so
 *     every paired device and relay binding is silently orphaned at every restart — the phone's
 *     stored public key can no longer derive a shared secret, and the desktop answers `bad_auth`
 *     with no explanation the user can act on. The only repair is re-scanning the QR code, and it
 *     is undone by the next restart. That is a permanently broken feature, not a re-auth prompt.
 *
 * So the cleartext fallback stays — but it is now the THIRD choice, not the second: a host with an
 * operator passphrase seals the identity with AES-256-GCM instead (see e2ee-identity-envelope.ts),
 * losslessly and with no keyring. The DEFAULT on a host that has neither a keychain nor a passphrase
 * still writes the private key in cleartext, so the credential-write report keeps classifying that
 * mint site `cleartext-fallback-unfixed`, and it must keep saying so until the default itself stops.
 * What this module owns is the ergonomics: the write is a named predicate, the file is 0600 /
 * owner-only ACL (`writeSecureJsonFile`), the envelope is self-describing
 * (`secretKeyFormat: 'plaintext'`), the next load that can seal upgrades it in place
 * (`migratePlaintextEnvelope`), and the operator gets ONE unmissable notice per launch naming the
 * exact file and every way out of it.
 *
 * Why this is NOT registered in SANCTIONED_POLICY_PREDICATES: that registry means "refuses in
 * packaged/production builds, requires an explicit dev env opt-in", which this predicate cannot
 * honour — headless production is exactly where it has to say yes. Registering it would dilute what
 * "guarded" means for the stores that do honour it, so the write stays in the credential-write
 * report's unguarded list, carrying this reasoning as its reviewed verdict.
 */

// Why an opt-OUT rather than an opt-in: the default has to keep mobile pairing working on the
// headless/SSH Linux hosts this fork targets; an operator who would rather lose pairing than hold a
// cleartext identity key can invert it.
export const REQUIRE_SEALED_E2EE_IDENTITY_ENV = 'ORCA_REQUIRE_SEALED_E2EE_IDENTITY'

// Why a second flag instead of just going quiet: the only way an operator could previously stop
// being warned was to break their own mobile pairing, so the notice had to be silenceable by
// accepting the risk on the record rather than by removing the fallback.
export const ACKNOWLEDGE_PLAINTEXT_E2EE_IDENTITY_ENV = 'ORCA_ACKNOWLEDGE_PLAINTEXT_E2EE_IDENTITY'

export function allowsPlaintextE2EEIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REQUIRE_SEALED_E2EE_IDENTITY_ENV] !== '1'
}

export const SEALED_E2EE_IDENTITY_REQUIRED_MESSAGE =
  `Neither the OS keychain nor an operator passphrase could seal this desktop's mobile E2EE identity, ` +
  `and ${REQUIRE_SEALED_E2EE_IDENTITY_ENV}=1 forbids storing it in cleartext, so no identity was ` +
  `created and mobile pairing is unavailable. Set ${SECRET_PASSPHRASE_FILE_ENV} to a file holding an ` +
  `operator passphrase (works headless, no keyring), launch once on a host whose keychain answers, or ` +
  `unset the flag to allow a 0600 cleartext identity that is upgraded as soon as either becomes available.`

// Why refuse loudly as well as returning the message: callers map `identity_unavailable` onto canned
// pairing guidance and drop the detail, so the operator's only copy of the real reason is this log.
export function warnSealedE2EEIdentityRequired(): void {
  console.warn(`[e2ee] ${SEALED_E2EE_IDENTITY_REQUIRED_MESSAGE}`)
}

/** `minted` = created in this launch; `loaded` = already on disk and this launch could not seal it. */
export type PlaintextE2EEIdentityEvent = 'minted' | 'loaded'

export type PlaintextE2EEIdentityNotice = {
  event: PlaintextE2EEIdentityEvent
  filePath: string
  keychainContext: E2EEKeychainContext
}

export function plaintextE2EEIdentityNoticeText(notice: PlaintextE2EEIdentityNotice): string {
  const origin =
    notice.event === 'minted'
      ? 'minted in this launch because the OS keychain could not seal it'
      : 'already on disk from an earlier launch, and this launch could not seal it either'
  return [
    `[e2ee] SECURITY NOTICE — this host holds its mobile transport PRIVATE key in CLEARTEXT at rest.`,
    `  file:  ${notice.filePath} (0600, secretKeyFormat: "plaintext")`,
    `  why:   ${origin} (keychain context: ${notice.keychainContext}), and no operator passphrase is set.`,
    `  risk:  anyone who can read the Orca data directory can impersonate this desktop to every paired device.`,
    `  fix:   set ${SECRET_PASSPHRASE_FILE_ENV} to a file holding an operator passphrase and relaunch — the key is`,
    `         re-sealed in place with AES-256-GCM on the next launch, no keyring and no re-pairing needed.`,
    `  or:    launch Orca once on this host with a working OS keychain; that re-seals it in place too.`,
    `  or:    set ${REQUIRE_SEALED_E2EE_IDENTITY_ENV}=1 to refuse the cleartext key instead; mobile pairing then stays`,
    `         unavailable on this host until one of the two above works, and already-paired devices keep working.`,
    `  quiet: set ${ACKNOWLEDGE_PLAINTEXT_E2EE_IDENTITY_ENV}=1 to accept this and stop printing the notice.`,
    `  Printed once per launch, on mint and on every load that leaves the key cleartext.`
  ].join('\n')
}

// Why module state and not a per-call flag: mint and load are different code paths that describe the
// SAME file, and a relay reconnect can re-enter both, so "once" has to be once per process.
let noticed = false

export function noticePlaintextE2EEIdentityAtRest(
  notice: PlaintextE2EEIdentityNotice,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (noticed || env[ACKNOWLEDGE_PLAINTEXT_E2EE_IDENTITY_ENV] === '1') {
    return
  }
  noticed = true
  console.warn(plaintextE2EEIdentityNoticeText(notice))
}
