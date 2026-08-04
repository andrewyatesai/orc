/**
 * Warm-state machine for this desktop's E2EE identity: single-flight, memoized where memoizing is
 * correct, and — after a transient keychain stall only — retryable on the desktop's own clock.
 * Without the retry, one 5s stall at startup would leave mobile and Relay dead for the whole
 * process lifetime, because nothing else ever asks again.
 */
import {
  resolveE2EEIdentity,
  type E2EEIdentityResolution,
  type E2EEKeypair,
  type E2EEKeypairResolveOptions
} from './e2ee-keypair'

/** Worst case one bounded child per minute, no matter how many peers reconnect how fast. */
const DEFAULT_REWARM_COOLDOWN_MS = 60_000

/**
 * Deliberately exposes no way to read the public half alone: the stored public key
 * and the *live* secret can disagree (an undecryptable envelope is regenerated on the
 * next resolve), and a pairing offer that advertises a public key whose secret half we
 * cannot produce yields a device that derives a shared secret nothing can decrypt.
 * Every public key handed out therefore comes from a resolved keypair.
 */
export type E2EEKeypairProvider = {
  /** Bounded (child process + hard kill), never synchronous. Coalesced; success and mint failure memoized. */
  resolve(): Promise<E2EEIdentityResolution>
  /** The already-warm keypair, or null. Contractually does zero keychain work — see mobile-socket-wiring. */
  peek(): E2EEKeypair | null
  /**
   * The attempt already in flight, or — only once a previous attempt refused transiently, and at
   * most once per cooldown — a fresh one. Null when nothing is coming, so the caller fails closed
   * immediately instead of hanging. Safe to reach from an unauthenticated path: a peer can neither
   * start the first attempt nor push the spawn rate above one child per cooldown.
   */
  awaitWarmAttempt(): Promise<E2EEIdentityResolution> | null
  /**
   * A sealed identity exists that a later attempt may still open. Callers refusing while
   * `awaitWarmAttempt()` is on cooldown must say "retry", not "re-pair" — the cooldown is our
   * rate limit, not evidence about the pairing.
   */
  isRetryable(): boolean
}

export type E2EEKeypairProviderOptions = E2EEKeypairResolveOptions & {
  rewarmCooldownMs?: number
}

export function createE2EEKeypairProvider(
  userDataPath: string,
  options: E2EEKeypairProviderOptions = {}
): E2EEKeypairProvider {
  const cooldownMs = options.rewarmCooldownMs ?? DEFAULT_REWARM_COOLDOWN_MS
  let warm: E2EEKeypair | null = null
  // Why: memoized both ways — a good file must not be re-unsealed per connection, and a
  // permanently broken one must not re-mint (and re-fail its write) on every pairing offer.
  // `unseal_failed` is deliberately NOT memoized: it is transient (a keychain that did not
  // answer), and retrying costs one bounded child, never a re-mint.
  let pending: Promise<E2EEIdentityResolution> | null = null
  let settled: E2EEIdentityResolution | null = null
  let refusedTransiently = false
  let lastAttemptStartedAtMs = 0

  const attempt = (): Promise<E2EEIdentityResolution> => {
    lastAttemptStartedAtMs = Date.now()
    pending = resolveE2EEIdentity(userDataPath, options)
      .catch((error: unknown) => identityUnavailable(error))
      .then((resolution) => {
        pending = null
        refusedTransiently = !resolution.ok && resolution.reason === 'unseal_failed'
        if (resolution.ok) {
          warm = resolution.keypair
        }
        if (resolution.ok || resolution.reason === 'identity_unavailable') {
          settled = resolution
        }
        return resolution
      })
    return pending
  }

  return {
    peek: () => warm,
    isRetryable: () => !settled && refusedTransiently,
    resolve: () => (settled ? Promise.resolve(settled) : (pending ?? attempt())),
    awaitWarmAttempt: () => {
      if (settled || !pending) {
        // Nothing memoized to wait for: only a cooled-down retry of a transient refusal may start one.
        const eligible =
          !settled && refusedTransiently && Date.now() - lastAttemptStartedAtMs >= cooldownMs
        return eligible ? attempt() : null
      }
      return pending
    }
  }
}

function identityUnavailable(detail: unknown): E2EEIdentityResolution {
  return {
    ok: false,
    reason: 'identity_unavailable',
    message: detail instanceof Error ? detail.message : String(detail)
  }
}
