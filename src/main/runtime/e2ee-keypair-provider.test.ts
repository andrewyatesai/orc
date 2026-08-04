import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { E2EESecretHelperResult } from './e2ee-secret-unseal-host'
import type { E2EESecretHelperRequest } from './e2ee-secret-unseal-protocol'

// Why: the child Electron process is the only keychain seam left (see e2ee-secret-unseal-host), so
// counting calls to it is the same as counting spawned children — which is what the rate bound is about.
const helperControl = vi.hoisted(() => ({
  answer: null as
    | ((
        request: E2EESecretHelperRequest
      ) => Promise<E2EESecretHelperResult> | E2EESecretHelperResult)
    | null
}))

const runHelper = vi.hoisted(() => vi.fn())

vi.mock('./e2ee-secret-unseal-host', () => ({
  runE2EESecretHelper: async (request: E2EESecretHelperRequest) => {
    runHelper(request)
    return await (helperControl.answer?.(request) ?? {
      ok: false,
      reason: 'helper_unavailable',
      message: 'no helper'
    })
  }
}))

function workingKeychain(request: E2EESecretHelperRequest): E2EESecretHelperResult {
  return request.op === 'seal'
    ? {
        ok: true,
        op: 'seal',
        ciphertextB64: Buffer.from(`enc:${request.secretKeyB64}`, 'utf-8').toString('base64')
      }
    : {
        ok: true,
        op: 'unseal',
        secretKeyB64: Buffer.from(request.ciphertextB64, 'base64')
          .toString('utf-8')
          .replace(/^enc:/, '')
      }
}

/** The shipped wedge: the helper was SIGKILLed because the OS keychain never answered. */
const wedgedKeychain = (): E2EESecretHelperResult => ({
  ok: false,
  reason: 'timeout',
  message: 'The OS keychain did not answer within 5000ms'
})

async function loadModule() {
  vi.resetModules()
  return import('./e2ee-keypair-provider')
}

async function seedSealedIdentity(userDataPath: string): Promise<string> {
  vi.resetModules()
  const { resolveE2EEIdentity } = await import('./e2ee-keypair')
  const resolution = await resolveE2EEIdentity(userDataPath)
  if (!resolution.ok) {
    throw new Error(`${resolution.reason}: ${resolution.message}`)
  }
  return resolution.keypair.publicKeyB64
}

const unsealCalls = (): number =>
  runHelper.mock.calls.filter((call) => (call[0] as E2EESecretHelperRequest).op === 'unseal').length

const COOLDOWN_MS = 60_000
const CLOCK_BASE = 1_700_000_000_000

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2ee-keypair-provider-'))
  helperControl.answer = workingKeychain
  runHelper.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(CLOCK_BASE)
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('createE2EEKeypairProvider', () => {
  it('exposes no way to read a public key without resolving the secret that backs it', async () => {
    const { createE2EEKeypairProvider } = await loadModule()
    const seeded = await seedSealedIdentity(dir)

    // Revert guard for the pairing-offer footgun: reading the stored public half is
    // cheap but it can name a secret that no longer decodes, so it is not offered.
    const provider = createE2EEKeypairProvider(dir)
    expect(Object.keys(provider).sort()).toEqual([
      'awaitWarmAttempt',
      'isRetryable',
      'peek',
      'resolve'
    ])
    const resolution = await provider.resolve()
    expect(resolution.ok && resolution.keypair.publicKeyB64).toBe(seeded)
  })

  it('leaves peek() empty — doing zero keychain work — until a resolve succeeds', async () => {
    const { createE2EEKeypairProvider } = await loadModule()
    await seedSealedIdentity(dir)

    const provider = createE2EEKeypairProvider(dir)
    runHelper.mockClear()
    // The property mobile-socket-wiring depends on: peek never reaches the keychain.
    expect(provider.peek()).toBeNull()
    expect(runHelper).not.toHaveBeenCalled()

    await provider.resolve()
    expect(provider.peek()?.secretKey.length).toBe(32)
  })

  it('never reports a public key whose secret half was regenerated behind it', async () => {
    const { createE2EEKeypairProvider } = await loadModule()
    const stale = await seedSealedIdentity(dir)

    helperControl.answer = () => ({
      ok: false,
      reason: 'keychain_error',
      message: 'rotated'
    })
    const resolution = await createE2EEKeypairProvider(dir).resolve()
    expect(resolution.ok).toBe(true)
    if (resolution.ok) {
      expect(resolution.keypair.publicKeyB64).not.toBe(stale)
      expect(Buffer.from(resolution.keypair.publicKey).toString('base64')).toBe(
        resolution.keypair.publicKeyB64
      )
    }
  })

  it('memoizes resolve() so an undecryptable file regenerates exactly once', async () => {
    const { createE2EEKeypairProvider } = await loadModule()
    const first = await seedSealedIdentity(dir)

    helperControl.answer = () => ({
      ok: false,
      reason: 'keychain_error',
      message: 'rotated'
    })
    const provider = createE2EEKeypairProvider(dir)
    const resolved = await provider.resolve()
    expect(resolved.ok && resolved.keypair.publicKeyB64).not.toBe(first)
    // Same object on re-resolve: no second mint, so paired devices are invalidated once.
    expect(await provider.resolve()).toBe(resolved)
  })

  it('memoizes a mint failure so a broken profile does not re-mint on every pairing offer', async () => {
    const { createE2EEKeypairProvider } = await loadModule()
    // A directory where the keypair file should be: every write attempt fails.
    const brokenPath = join(dir, 'not-a-directory')
    writeFileSync(brokenPath, '')
    const provider = createE2EEKeypairProvider(brokenPath)

    const first = await provider.resolve()
    expect(first).toMatchObject({ ok: false, reason: 'identity_unavailable' })
    expect(await provider.resolve()).toBe(first)
  })

  it('retries after an unseal timeout instead of memoizing a transient keychain stall', async () => {
    await seedSealedIdentity(dir)
    const { createE2EEKeypairProvider } = await loadModule()
    const provider = createE2EEKeypairProvider(dir)

    helperControl.answer = wedgedKeychain
    expect(await provider.resolve()).toMatchObject({
      ok: false,
      reason: 'unseal_failed'
    })

    // The user unlocked the keychain / launched the real app: the next attempt must not be
    // answered from a memoized refusal.
    helperControl.answer = workingKeychain
    expect(await provider.resolve()).toMatchObject({ ok: true })
    expect(provider.peek()).not.toBeNull()
  })

  it('coalesces concurrent resolves onto a single helper invocation', async () => {
    await seedSealedIdentity(dir)
    const { createE2EEKeypairProvider } = await loadModule()
    const provider = createE2EEKeypairProvider(dir)
    runHelper.mockClear()

    const [a, b] = await Promise.all([provider.resolve(), provider.resolve()])
    expect(a).toBe(b)
    expect(runHelper).toHaveBeenCalledTimes(1)
  })
})

describe('awaitWarmAttempt', () => {
  it('hands back the warm already in flight rather than starting a second one', async () => {
    // R1: the WebSocket listener binds while the startup warm is still running, so an arriving
    // frame must be able to WAIT for it — the alternative is refusing a paired phone 4001.
    await seedSealedIdentity(dir)
    const { createE2EEKeypairProvider } = await loadModule()
    const provider = createE2EEKeypairProvider(dir)
    let releaseKeychain: (() => void) | null = null
    helperControl.answer = (request) =>
      new Promise<E2EESecretHelperResult>((resolve) => {
        releaseKeychain = () => resolve(workingKeychain(request))
      })
    runHelper.mockClear()

    const startupWarm = provider.resolve()
    const arrivingFrame = provider.awaitWarmAttempt()
    expect(arrivingFrame).toBe(startupWarm)
    expect(provider.peek()).toBeNull()

    releaseKeychain!()
    expect(await arrivingFrame).toMatchObject({ ok: true })
    // One child for the desktop's warm and the peer that waited on it, not one each.
    expect(unsealCalls()).toBe(1)
    expect(provider.peek()?.secretKey.length).toBe(32)
  })

  it('starts nothing at all before the desktop has attempted its own warm', async () => {
    await seedSealedIdentity(dir)
    const { createE2EEKeypairProvider } = await loadModule()
    const provider = createE2EEKeypairProvider(dir)
    runHelper.mockClear()

    // D2: unauthenticated network input may join an attempt, never be the thing that starts one.
    expect(provider.awaitWarmAttempt()).toBeNull()
    expect(runHelper).not.toHaveBeenCalled()
  })

  it('reports a sealed identity as retryable through the whole cooldown gap', async () => {
    // The live defect this pins: 42 of 45 connections landed BETWEEN re-warm attempts, where
    // awaitWarmAttempt() is null. Reading that gap as "no identity" refuses 4001 and burns the
    // phone's three-strike budget on a pairing that is perfectly valid.
    await seedSealedIdentity(dir)
    const { createE2EEKeypairProvider } = await loadModule()
    const provider = createE2EEKeypairProvider(dir, { rewarmCooldownMs: COOLDOWN_MS })

    expect(provider.isRetryable()).toBe(false)

    helperControl.answer = wedgedKeychain
    expect(await provider.resolve()).toMatchObject({ ok: false, reason: 'unseal_failed' })

    expect(provider.isRetryable()).toBe(true)
    // Still true where there is nothing to await — that gap is the common case, not the edge.
    expect(provider.awaitWarmAttempt()).toBeNull()
    expect(provider.isRetryable()).toBe(true)
  })

  it('stops reporting retryable once the identity resolves for good', async () => {
    await seedSealedIdentity(dir)
    const { createE2EEKeypairProvider } = await loadModule()
    const provider = createE2EEKeypairProvider(dir, { rewarmCooldownMs: COOLDOWN_MS })

    helperControl.answer = wedgedKeychain
    await provider.resolve()
    expect(provider.isRetryable()).toBe(true)

    helperControl.answer = workingKeychain
    vi.setSystemTime(CLOCK_BASE + COOLDOWN_MS)
    expect(await provider.awaitWarmAttempt()).toMatchObject({ ok: true })
    // A warm identity is not "retry later" — nothing is pending and nothing is broken.
    expect(provider.isRetryable()).toBe(false)
  })

  it('re-warms once per cooldown after a transient stall, however many peers connect', async () => {
    // R2: without this, one 5s keychain stall at startup leaves mobile and Relay dead until the
    // process restarts — nothing else ever asks again.
    await seedSealedIdentity(dir)
    const { createE2EEKeypairProvider } = await loadModule()
    const provider = createE2EEKeypairProvider(dir, {
      rewarmCooldownMs: COOLDOWN_MS
    })

    helperControl.answer = wedgedKeychain
    expect(await provider.resolve()).toMatchObject({
      ok: false,
      reason: 'unseal_failed'
    })
    runHelper.mockClear()

    // Reconnect storm inside the cooldown: the bound is the desktop's clock, not the peer's rate.
    for (let i = 0; i < 20; i++) {
      expect(provider.awaitWarmAttempt()).toBeNull()
    }
    expect(runHelper).not.toHaveBeenCalled()

    vi.setSystemTime(CLOCK_BASE + COOLDOWN_MS)
    const burst = Array.from({ length: 5 }, () => provider.awaitWarmAttempt())
    expect(burst.every((attempt) => attempt === burst[0])).toBe(true)
    await Promise.all(burst)
    expect(unsealCalls()).toBe(1)

    // ...and the retry is what recovers the session once the keychain answers again.
    vi.setSystemTime(CLOCK_BASE + 2 * COOLDOWN_MS)
    helperControl.answer = workingKeychain
    expect(await provider.awaitWarmAttempt()).toMatchObject({ ok: true })
    expect(provider.peek()?.secretKey.length).toBe(32)
  })

  it('never re-warms once the identity is memoized, warm or unavailable', async () => {
    const { createE2EEKeypairProvider } = await loadModule()
    const warmed = createE2EEKeypairProvider(dir, {
      rewarmCooldownMs: COOLDOWN_MS
    })
    expect(await warmed.resolve()).toMatchObject({ ok: true })

    const brokenPath = join(dir, 'not-a-directory')
    writeFileSync(brokenPath, '')
    const unavailable = createE2EEKeypairProvider(brokenPath, {
      rewarmCooldownMs: COOLDOWN_MS
    })
    expect(await unavailable.resolve()).toMatchObject({
      ok: false,
      reason: 'identity_unavailable'
    })
    runHelper.mockClear()

    // Long past any cooldown: success needs no repeat, and a profile that cannot hold an identity
    // must not re-mint (and re-fail its write) on every connection.
    vi.setSystemTime(CLOCK_BASE + 3600_000)
    expect(warmed.awaitWarmAttempt()).toBeNull()
    expect(unavailable.awaitWarmAttempt()).toBeNull()
    expect(runHelper).not.toHaveBeenCalled()
  })
})
