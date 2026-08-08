// Type-only, so this stays a compile-time reference and creates no import cycle with e2ee-keypair.
import type { E2EEKeychainContext } from './e2ee-keypair'

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
 * So the cleartext fallback stays. What changes is that it is no longer invisible: it is this named
 * predicate, it warns on every write and on every load that leaves the key cleartext, the file is
 * 0600 / owner-only ACL (`writeSecureJsonFile`), the envelope is self-describing
 * (`secretKeyFormat: 'plaintext'`), and the next interactive load upgrades it to a sealed envelope
 * (`migratePlaintextEnvelope`).
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

export function allowsPlaintextE2EEIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REQUIRE_SEALED_E2EE_IDENTITY_ENV] !== '1'
}

export const SEALED_E2EE_IDENTITY_REQUIRED_MESSAGE =
  `The OS keychain could not seal this desktop's mobile E2EE identity and ` +
  `${REQUIRE_SEALED_E2EE_IDENTITY_ENV}=1 forbids storing it in cleartext, so no identity was created ` +
  `and mobile pairing is unavailable. Unset it to allow a 0600 cleartext identity (upgraded to a ` +
  `sealed one on the next interactive launch), or launch once on a host whose keychain answers.`

// Why refuse loudly as well as returning the message: callers map `identity_unavailable` onto canned
// pairing guidance and drop the detail, so the operator's only copy of the real reason is this log.
export function warnSealedE2EEIdentityRequired(): void {
  console.warn(`[e2ee] ${SEALED_E2EE_IDENTITY_REQUIRED_MESSAGE}`)
}

export function warnPlaintextE2EEIdentityMinted(keychainContext: E2EEKeychainContext): void {
  console.warn(
    `[e2ee] Minted this desktop's mobile E2EE identity with its private key in CLEARTEXT at rest ` +
      `(0600, secretKeyFormat: "plaintext") because the OS keychain could not seal it ` +
      `(keychain context: ${keychainContext}). Anyone who can read the Orca data directory can ` +
      `impersonate this desktop to paired devices. The next interactive launch upgrades it to a ` +
      `sealed envelope; set ${REQUIRE_SEALED_E2EE_IDENTITY_ENV}=1 to refuse instead (mobile pairing ` +
      `then stays unavailable until the keychain works).`
  )
}

export function warnPlaintextE2EEIdentityLoaded(keychainContext: E2EEKeychainContext): void {
  console.warn(
    `[e2ee] Loaded this desktop's mobile E2EE identity from a CLEARTEXT envelope and could not ` +
      `upgrade it to the OS keychain (keychain context: ${keychainContext}). The private key stays ` +
      `readable to anyone who can read the Orca data directory until an interactive launch seals it.`
  )
}
