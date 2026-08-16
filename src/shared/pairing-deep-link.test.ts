// The twin's own tests, moved here with `src/shared/pairing.ts`'s codec, plus
// the cases a cutover needs and the twin never had.
//
// EVERY case runs in BOTH seam states. `config/vitest-orca-dispatch-seam.ts`
// binds the shared seam for every test file at import time, so a test that only
// ran as-imported would prove the Rust core and say nothing about the pre-ready
// fallback the renderer and the relay run before their binding lands — and a
// fallback-vs-core differential cannot see a divergence that only appears BOUND
// (`stable-pane-id`'s lesson: bound and unbound must both equal the TWIN).
import { describe, expect, it } from 'vitest'
import {
  decodePairingOffer,
  encodePairingOffer,
  parsePairingCode,
  type PairingOffer
} from './pairing-deep-link'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

/** A fixed instant: the schema's invite window is wall-clock, and a test that
 *  read the real clock would compare two different instants across the two seam
 *  states. Every call below passes it explicitly. */
const NOW = 1_783_872_000_000
const CANONICAL_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const INVITE_TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'

const offer: PairingOffer = {
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  // Deliberately deadbeef: the token is echoed inside base64 pairing codes, so a
  // random-looking one reads as a real credential wherever those codes are stored
  // (parity goldens included). Keep this and tools/parity/vectors/pairing.json in step.
  deviceToken: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  publicKeyB64: 'dGVzdC1wdWJsaWMta2V5LWJhc2U2NC1lbmNvZGVk'
}

const pasteOffer: PairingOffer = {
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'token-abc',
  publicKeyB64: 'pubkey-xyz'
}

function relayOffer(overrides: Partial<NonNullable<PairingOffer['relay']>> = {}): PairingOffer {
  return {
    ...offer,
    publicKeyB64: CANONICAL_KEY,
    relay: {
      v: 1,
      directorUrl: 'https://relay.onorca.dev',
      cellUrl: 'https://relay-c1.onorca.dev',
      assignmentEpoch: 7,
      relayHostId: 'AbCdEf0123_-xyZ9',
      inviteToken: INVITE_TOKEN,
      inviteExpiresAt: NOW + 5 * 60 * 1000,
      e2eeFraming: 2,
      ...overrides
    }
  }
}

/** A throw is an answer here — `decodePairingOffer` rejects by throwing and
 *  three callers catch it — so shape both into one comparable value. */
function outcome(call: () => unknown): unknown {
  try {
    return { ok: call() }
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) }
  }
}

type WireCall = { module: string; fn: string; input: string; answer: string }

/** Bind the seam to the shipped wasm core and record what crossed it. The
 *  fallback is exact parity, which is the point of the cutover and also what
 *  makes a MIS-WIRED seam invisible from the result alone: route the shim at the
 *  wrong dispatch arm and every answer is still right, from the fallback, with
 *  the core inert. So some cases watch the wire, not the return value. */
function recordWire(): WireCall[] {
  const wire: WireCall[] = []
  // The global setup already ran initSync; rebinding is just the callback.
  setOrcaDispatchBinding((module, fn, input) => {
    const answer = orcaDispatch(module, fn, input)
    wire.push({ module, fn, input, answer })
    return answer
  })
  return wire
}

/** Run the same call with the seam unbound (the pre-ready fallback) and bound
 *  to the shipped wasm core, and hand back both answers plus what crossed. */
function inBothSeamStates(call: () => unknown): {
  unbound: unknown
  bound: unknown
  wire: WireCall[]
} {
  setOrcaDispatchBinding(null)
  const unbound = outcome(call)
  const wire = recordWire()
  const bound = outcome(call)
  return { unbound, bound, wire }
}

/** The cutover's central claim: the pre-ready fallback IS the ready answer. */
function expectBothSeamStates(call: () => unknown, expected: unknown): void {
  const { unbound, bound } = inBothSeamStates(call)
  expect(unbound).toEqual(expected)
  expect(bound).toEqual(expected)
}

const code = (url: string): string =>
  new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('code')!

// The pre-ready contract in the shape the git-wasm gate uses
// (shim-pre-ready-contract.test.ts): snapshot at module load with NOTHING bound
// — the state the renderer and the relay are in before their binding lands —
// then compare against the ready answer. It lives here rather than as rows in
// that gate because that file is mid-refactor on another branch of the working
// tree (+1,140 uncommitted lines, already 1,517 over its 800-line budget), and
// because per-call unbinding cannot catch a shim that memoized the core.
// `parity` x3: every answer is total, and the offers are persisted into the
// runtime-environment record, so no sentinel has anywhere to live.
setOrcaDispatchBinding(null)
const PRE_READY = {
  encodeRelayOffer: outcome(() => encodePairingOffer(relayOffer(), NOW)),
  parseRelayCode: outcome(() => parsePairingCode(encodePairingOffer(relayOffer(), NOW), NOW)),
  encodePunycodeRelay: outcome(() =>
    encodePairingOffer(relayOffer({ cellUrl: 'https://xn--80ak6aa92e.com' }), NOW)
  )
}
setOrcaDispatchBinding((module, fn, input) => orcaDispatch(module, fn, input))

describe('pre-ready contract', () => {
  it('encodePairingOffer(relay offer) — pre-ready matches ready', () => {
    expect(PRE_READY.encodeRelayOffer).toEqual(outcome(() => encodePairingOffer(relayOffer(), NOW)))
  })

  it('parsePairingCode(relay code) — pre-ready matches ready', () => {
    expect(PRE_READY.parseRelayCode).toEqual(
      outcome(() => parsePairingCode(encodePairingOffer(relayOffer(), NOW), NOW))
    )
  })

  it('encodePairingOffer(xn-- relay origin) — pre-ready REFUSES, like ready', () => {
    expect(PRE_READY.encodePunycodeRelay).toHaveProperty('threw')
    expect(PRE_READY.encodePunycodeRelay).toEqual(
      outcome(() => encodePairingOffer(relayOffer({ cellUrl: 'https://xn--80ak6aa92e.com' }), NOW))
    )
  })
})

describe('pairing offer', () => {
  it('encode then decode round-trips correctly', () => {
    const url = encodePairingOffer(offer, NOW)
    expect(url).toMatch(/^orca:\/\/pair\?code=/)
    expectBothSeamStates(() => encodePairingOffer(offer, NOW), { ok: url })
    expectBothSeamStates(() => decodePairingOffer(url, NOW), { ok: offer })
  })

  it('preserves optional device scope metadata', () => {
    const scopedOffer: PairingOffer = { ...offer, scope: 'mobile' }
    expectBothSeamStates(() => decodePairingOffer(encodePairingOffer(scopedOffer, NOW), NOW), {
      ok: scopedOffer
    })
  })

  it('an explicitly undefined optional still crosses as an absent key', () => {
    // `{...offer, scope: undefined}` is how callers spell "no scope". Without
    // the codec's omit opt-in it is REJECTED before crossing and the shim
    // silently answers from the fallback forever, so watch the wire rather than
    // the result — the two agree either way, which is what hides it.
    const wire = recordWire()
    const url = encodePairingOffer({ ...offer, scope: undefined, relay: undefined }, NOW)
    expect(wire).toHaveLength(1)
    expect(JSON.parse(wire[0]!.input).offer).not.toHaveProperty('scope')
    expect(url).toBe(encodePairingOffer(offer, NOW))
    expect(Buffer.from(code(url), 'base64url').toString('utf-8')).not.toContain('scope')
  })

  it('round-trips a TLS reverse-proxy endpoint with an explicit port and path', () => {
    const proxiedOffer = { ...offer, endpoint: 'wss://proxy.example:443/orca/runtime' }
    expectBothSeamStates(() => decodePairingOffer(encodePairingOffer(proxiedOffer, NOW), NOW), {
      ok: proxiedOffer
    })
  })

  it('encoded URL uses base64url (no +, /, or = characters)', () => {
    expect(code(encodePairingOffer(offer, NOW))).not.toMatch(/[+/=]/)
  })

  it('rejects URLs with wrong scheme', () => {
    expectBothSeamStates(() => decodePairingOffer('https://example.com#abc', NOW), {
      threw: 'Invalid pairing URL: must start with orca://pair and include a pairing code'
    })
  })

  it('rejects orca URLs outside the exact pairing route', () => {
    const value = code(encodePairingOffer(offer, NOW))
    expectBothSeamStates(() => parsePairingCode(`orca://pairing?code=${value}`, NOW), { ok: null })
    expectBothSeamStates(() => parsePairingCode(`orca://pair-extra?code=${value}`, NOW), {
      ok: null
    })
    expectBothSeamStates(() => decodePairingOffer(`orca://pairing?code=${value}`, NOW), {
      threw: 'Invalid pairing URL: must start with orca://pair and include a pairing code'
    })
  })

  it('rejects URLs without a pairing code', () => {
    expectBothSeamStates(() => decodePairingOffer('orca://pair', NOW), {
      threw: 'Invalid pairing URL: must start with orca://pair and include a pairing code'
    })
  })

  it('decodes legacy hash URLs', () => {
    const value = code(encodePairingOffer(offer, NOW))
    expectBothSeamStates(() => decodePairingOffer(`orca://pair#${value}`, NOW), { ok: offer })
  })

  it('rejects payloads with missing fields', () => {
    const partial = { v: 2, endpoint: 'ws://host:1234' }
    const base64 = Buffer.from(JSON.stringify(partial)).toString('base64')
    const { unbound, bound } = inBothSeamStates(() =>
      decodePairingOffer(`orca://pair#${base64}`, NOW)
    )
    expect(unbound).toHaveProperty('threw')
    expect(bound).toHaveProperty('threw')
  })

  it('rejects payloads with wrong version', () => {
    const base64 = Buffer.from(JSON.stringify({ ...offer, v: 1 })).toString('base64')
    const { unbound, bound } = inBothSeamStates(() =>
      decodePairingOffer(`orca://pair#${base64}`, NOW)
    )
    expect(unbound).toHaveProperty('threw')
    expect(bound).toHaveProperty('threw')
  })

  it('rejects payloads with missing publicKeyB64', () => {
    const wrong = { v: 2, endpoint: 'ws://host:1234', deviceToken: 'tok' }
    const base64 = Buffer.from(JSON.stringify(wrong)).toString('base64')
    const { unbound, bound } = inBothSeamStates(() =>
      decodePairingOffer(`orca://pair#${base64}`, NOW)
    )
    expect(unbound).toHaveProperty('threw')
    expect(bound).toHaveProperty('threw')
  })
})

describe('parsePairingCode', () => {
  it('parses a full orca://pair URL', () => {
    expectBothSeamStates(() => parsePairingCode(encodePairingOffer(pasteOffer, NOW), NOW), {
      ok: pasteOffer
    })
  })

  it('parses a bare base64url payload (without scheme prefix)', () => {
    const value = code(encodePairingOffer(pasteOffer, NOW))
    expectBothSeamStates(() => parsePairingCode(value, NOW), { ok: pasteOffer })
  })

  it('tolerates surrounding whitespace from clipboard', () => {
    const url = encodePairingOffer(pasteOffer, NOW)
    expectBothSeamStates(() => parsePairingCode(`  ${url}\n`, NOW), { ok: pasteOffer })
  })

  it('returns null for empty input', () => {
    expectBothSeamStates(() => parsePairingCode('', NOW), { ok: null })
    expectBothSeamStates(() => parsePairingCode('   ', NOW), { ok: null })
  })

  it('returns null for garbage input', () => {
    expectBothSeamStates(() => parsePairingCode('not a pairing code', NOW), { ok: null })
    expectBothSeamStates(() => parsePairingCode('https://example.com', NOW), { ok: null })
  })

  it('returns null for valid base64 of unrelated JSON', () => {
    const bogus = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64')
    expectBothSeamStates(() => parsePairingCode(bogus, NOW), { ok: null })
  })
})

describe('the clock is an argument, and both legs read the same one', () => {
  it('a relay offer round-trips at the instant it was minted', () => {
    expectBothSeamStates(() => decodePairingOffer(encodePairingOffer(relayOffer(), NOW), NOW), {
      ok: relayOffer()
    })
  })

  it('the SAME offer is refused at an instant past its invite expiry', () => {
    const url = encodePairingOffer(relayOffer(), NOW)
    const later = NOW + 6 * 60 * 1000
    const { unbound, bound } = inBothSeamStates(() => decodePairingOffer(url, later))
    expect(unbound).toHaveProperty('threw')
    expect(bound).toHaveProperty('threw')
    expectBothSeamStates(() => parsePairingCode(url, later), { ok: null })
  })

  it('encode refuses an offer whose invite has already expired at nowMs', () => {
    const stale = relayOffer({ inviteExpiresAt: NOW })
    const { unbound, bound } = inBothSeamStates(() => encodePairingOffer(stale, NOW))
    expect(unbound).toHaveProperty('threw')
    expect(bound).toHaveProperty('threw')
    // ...and the same offer is fine one millisecond earlier on the clock.
    const { unbound: earlyUnbound, bound: earlyBound } = inBothSeamStates(() =>
      encodePairingOffer(stale, NOW - 1)
    )
    expect(earlyUnbound).toHaveProperty('ok')
    expect(earlyBound).toHaveProperty('ok')
  })
})

describe('declared residuals — the core refuses what the twin accepted', () => {
  it('(1) an xn-- relay origin is refused, in both seam states', () => {
    for (const key of ['directorUrl', 'cellUrl'] as const) {
      const punycode = relayOffer({ [key]: 'https://xn--80ak6aa92e.com' })
      const { unbound, bound } = inBothSeamStates(() => encodePairingOffer(punycode, NOW))
      expect(unbound).toHaveProperty('threw')
      expect(bound).toHaveProperty('threw')
    }
    // The rule is the xn-- label, not "any relay origin": the fixture still encodes.
    expect(outcome(() => encodePairingOffer(relayOffer(), NOW))).toHaveProperty('ok')
  })

  it('(2) a lone-surrogate escape in the payload is refused, in both seam states', () => {
    // The URL itself is pure ASCII, so it crosses the codec; serde_json refuses
    // the DOCUMENT the base64 decodes to, which JSON.parse admits.
    const json = '{"v":2,"endpoint":"a\\ud800b","deviceToken":"t","publicKeyB64":"k"}'
    const url = `orca://pair#${Buffer.from(json, 'utf-8').toString('base64url')}`
    expect(JSON.parse(json)).toBeTruthy()
    expectBothSeamStates(() => parsePairingCode(url, NOW), { ok: null })
  })

  it('(3) a number outside f64 range is refused even on a stripped key', () => {
    const json = `{"v":2,"endpoint":"a","deviceToken":"t","publicKeyB64":"${CANONICAL_KEY}","junk":1e400}`
    const url = `orca://pair#${Buffer.from(json, 'utf-8').toString('base64url')}`
    // zod STRIPS `junk`, so the twin returned the offer; serde_json never got
    // past parsing the document.
    expect(JSON.parse(json).junk).toBe(Number.POSITIVE_INFINITY)
    expectBothSeamStates(() => parsePairingCode(url, NOW), { ok: null })
  })
})

describe('the bound seam answers from the CORE, not from the fallback', () => {
  // Without this, a shim wired to the wrong dispatch arm passes every other test
  // in this file: `rust/crates/orca-dispatch/src/modules/pairing.rs` reads its
  // input as the bare offer/string at clock 0, so `{nowMs, offer}` reaches it as
  // an empty offer, it answers null to everything, and the exact-parity fallback
  // quietly supplies the right answer forever.
  it.each([
    ['encodePairingOffer', () => encodePairingOffer(relayOffer(), NOW)],
    ['decodePairingOffer', () => decodePairingOffer(encodePairingOffer(relayOffer(), NOW), NOW)],
    ['parsePairingCode', () => parsePairingCode(encodePairingOffer(relayOffer(), NOW), NOW)]
  ] as const)('%s is computed in Rust', (fn, call) => {
    const wire = recordWire()
    expect(outcome(call)).toHaveProperty('ok')
    const answered = wire.filter((entry) => entry.fn === fn)
    expect(answered.length).toBeGreaterThan(0)
    expect(answered.at(-1)!.module).toBe('mobile-relay-pairing-offer')
    // `null` is what a wrong arm, a stale core and a rejected offer all return,
    // and all three route to the fallback — so the core must have answered.
    expect(answered.at(-1)!.answer).not.toBe('null')
  })
})

describe('non-string inputs answer the twin in BOTH seam states', () => {
  // The types say string, but a deep link arrives from process.argv, an Electron
  // open-url event and the relay wire. The twin read `.length` and `.trim()`;
  // the core's adapter reads a non-string as the EMPTY STRING and answers "no
  // code", which is a different answer and only visible once bound.
  // The guard's contract is that a non-string is never SENT: the adapter reads
  // one as `unwrap_or_default()` — the empty string — so today its null routes
  // back to the fallback and the answer happens to match. Tighten that adapter
  // to reject a non-string and the envelope becomes a DispatchCoreError throw
  // where the twin answered, so the wire assertion is the guard, not the result.
  it('parsePairingCode throws the twin TypeError rather than answering null', () => {
    for (const value of [null, undefined, 123, [], {}] as never[]) {
      const { unbound, bound, wire } = inBothSeamStates(() => parsePairingCode(value, NOW))
      expect(unbound).toHaveProperty('threw')
      expect(unbound).toEqual(bound)
      expect(wire).toEqual([])
    }
  })

  it('decodePairingOffer routes an array through the URL parser like the twin', () => {
    const { unbound, bound, wire } = inBothSeamStates(() => decodePairingOffer([] as never, NOW))
    expect(unbound).toEqual({
      threw: 'Invalid pairing URL: must start with orca://pair and include a pairing code'
    })
    expect(bound).toEqual(unbound)
    expect(wire).toEqual([])
  })

  it('encodePairingOffer rejects a non-offer through the schema in both states', () => {
    for (const value of [null, 'nope', 42, []] as never[]) {
      const { unbound, bound } = inBothSeamStates(() => encodePairingOffer(value, NOW))
      expect(unbound).toHaveProperty('threw')
      expect(bound).toHaveProperty('threw')
    }
  })

  it('a stripped sibling key cannot block the crossing', () => {
    // zod drops unknown keys, so the twin encoded this fine. Send the CALLER's
    // object instead of the validated one and a lone surrogate on a key the
    // schema never reads fails the codec, the shim answers from the fallback,
    // and the core is quietly retired for every offer that carries notes.
    const wire = recordWire()
    const url = encodePairingOffer({ ...offer, junk: 'a\ud800b' } as never, NOW)
    expect(wire).toHaveLength(1)
    expect(url).toBe(encodePairingOffer(offer, NOW))
  })

  it('an offer carrying a lone surrogate cannot cross, and the fallback answers', () => {
    // encodeDispatchPayload refuses to send it (JSON.stringify writes an escape
    // that is not valid UTF-8), the twin encoded it without crossing anything,
    // so both states must produce the twin's link rather than a payload error.
    const lone = { ...offer, deviceToken: 'a\ud800b' }
    const { unbound, bound } = inBothSeamStates(() => encodePairingOffer(lone, NOW))
    expect(unbound).toHaveProperty('ok')
    expect(bound).toEqual(unbound)
  })
})
