// Pairing deep links (`orca://pair?code=<base64url>`) on the Rust
// `orca_relay::pairing` core. The codec body was DELETED from
// `src/shared/pairing.ts`, which keeps the types, the re-exported schema and the
// four route/shape constants the fallback below is rebuilt from. It sits on
// `orca-dispatch-seam` rather than in one tree's binding directory because these
// three functions run on EVERY surface: `runtime-rpc.ts` mints the link in main
// (napi), the CLI runtime client parses one (napi), and
// `runtime-environment-store.ts` / `ephemeral-vm-recipes.ts` parse one from
// `src/shared`, which also runs under the SSH relay (wasm via initSync).
//
// THE DISPATCH ARM IS `mobile-relay-pairing-offer`, NOT `pairing`. Both arms
// wrap the same crate, but `rust/crates/orca-dispatch/src/modules/pairing.rs`
// hardcodes `VECTOR_CLOCK_MS = 0` so its vector corpus compares at a named
// instant. Routed there, a real invite (`inviteExpiresAt` ~1.7e12) sits far past
// `0 + 10min + 30s` and EVERY relay offer is refused. The sibling arm reads
// `nowMs` off the payload, which is the whole reason the Rust schema takes the
// clock as an argument instead of reading one — `orca-relay` compiles to wasm,
// where `SystemTime::now()` panics.
//
// THE CLOCK IS THREADED, NOT READ TWICE. Each entry point reads the wall clock
// AT MOST ONCE, into `nowMs`, and hands that one instant to the core AND to the
// fallback; callers that already own an instant pass it and nothing here reads a
// clock at all. Nothing below calls `Date.now()` a second time. An invite window
// evaluated at two instants is not parity — it is two answers that agree only
// while the machine is idle, and the boundary case is a five-minute invite.
//
// PRE-READY CONTRACT — `parity` x3, and it is FORCED, not chosen. There is no
// spare state to signal with: `encodePairingOffer` returns the deep link that
// goes on screen as a QR code, `decodePairingOffer` throws or returns the offer,
// and `parsePairingCode` already returns the twin's real `null` for "that is not
// a pairing code". The offers themselves are PERSISTED — `runtime-environment-
// store.ts` parses one back out of the stored environment record on every read —
// so a plausible stand-in would be written to disk as a relay a device trusts.
// The fallback therefore recomputes the deleted bodies over the constants the
// twin keeps plus `createPairingOfferSchema(() => nowMs)`, the twin's own clock
// injection point, so pre-ready equals ready for every input.
//
// PROVED, not asserted: 7,522 inputs run through BOTH seam states — every
// single-position substitute/insert/delete over a valid deep link at 25
// positions, every field of the offer and of the relay sub-object crossed with
// 27 and 41 values, the invite window at its boundaries under 15 instants, 1,500
// randomized offers, 900 fuzzed codes and 400 randomized payloads — 0
// divergences, against the shipped `orca_git_wasm_bg.wasm`. The corpus is
// discriminating: it reddens at 8 cases if the fallback drops the xn-- refusal,
// 4 if it drops the serde-json refusal, 4 if it checks only `directorUrl`, 1 if
// it skips object keys, and 2,052 if the encode arm dispatches before it
// validates. Comparing the two seam states is NOT enough on its own — a core
// refusal is a null and the shim reads a null as "no answer", so a fallback that
// stopped refusing is simply believed in both states; the residual guards are
// held by a second comparison against the RAW core.
//
// DECLARED RESIDUALS. All three are the core REFUSING an offer the TypeScript
// twin accepted — the safe direction for a value that names the relay a device
// will trust — and all three are MIRRORED in the fallback, so the pre-ready
// answer never accepts what the ready core refuses:
//   1. An `xn--` label in `relay.directorUrl` or `relay.cellUrl`. Deciding it
//      needs punycode plus the IDNA validity tables, which
//      `orca-relay::canonical_https_origin` does not carry, so it refuses rather
//      than guesses. This is the pair of mismatches the sibling schema's 723
//      vectors report (`allowDivergence`, "IDNA/punycode is not modeled"). Those
//      two vectors stay declared because they drive `validatePairingOffer`, the
//      RAW schema, which is a different module and is not cut over; the three
//      deep-link arms go through here and now agree.
//   2. A lone-surrogate `\uD800` escape anywhere in the decoded payload.
//      serde_json rejects the whole document; `JSON.parse` admits it.
//   3. A number literal outside f64 range anywhere in the decoded payload.
//      serde_json rejects the document; `JSON.parse` rounds it to +/-Infinity.
// (2) and (3) are refused before the schema runs, and they bite on keys zod
// STRIPS — an offer with `{"junk":1e400}` decodes in TS and does not in Rust —
// so the guard walks the raw parsed payload, not the validated offer. Their two
// vectors were `allowDivergence` and are now a hard gate, so losing the mirror
// turns `pnpm parity` red instead of printing a warning nobody reads.
//
// A FOURTH residual is NOT declared, it is closed: the encode dispatch arm
// repairs an invalid offer instead of rejecting it. See `encodePairingOffer`.
//
// One more disclosed decision, inherited: `orca-relay` turns on serde_json's
// `preserve_order` because a pairing code is base64 of `JSON.stringify` output,
// so the encoded bytes depend on key order. `pairing_offer_to_json` inserts in
// zod shape order and `preserve_order` keeps it; without it the code would be
// alphabetized and no existing client could read it.
//
// What does NOT reach the core: an offer carrying a lone surrogate on any field.
// `encodeDispatchPayload` refuses to send it (`JSON.stringify` writes an escape
// that is not valid UTF-8, so Rust cannot parse the payload at all), the twin
// encoded it without crossing anything, and the fallback answers. Only that
// encode rejection is caught; a `DispatchCoreError` still propagates.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import {
  PAIRING_CODE_MAX_CHARACTERS,
  PAIRING_INPUT_MAX_CHARACTERS,
  createPairingOfferSchema
} from './mobile-relay-pairing-offer'
import {
  PAIRING_CODE_PATTERN,
  PAIRING_DEEP_LINK_CODE_PARAM,
  PAIRING_DEEP_LINK_HOSTNAME,
  PAIRING_DEEP_LINK_PROTOCOL,
  type PairingOffer
} from './pairing'

export type { PairingOffer } from './pairing'

/** The arm that takes the clock as an argument; see the header on `pairing`. */
const DISPATCH_MODULE = 'mobile-relay-pairing-offer'

const PUNYCODE_RELAY_REFUSAL =
  'Invalid pairing offer: relay origins with an xn-- label are refused (IDNA is not modeled)'
const UNPORTABLE_PAYLOAD_REFUSAL =
  'Invalid pairing code: payload carries a lone surrogate or an out-of-range number'

/** `null` means "the seam is unbound, or the payload cannot cross" — never an
 *  answer. It is also what the core returns for a rejected offer, and collapsing
 *  the two is safe only because this shim is `parity`: the fallback refuses
 *  exactly what the core refuses, so recomputing reproduces that same rejection
 *  (as the twin's own throw, which callers branch on). */
function dispatchPairing(fn: string, input: unknown): unknown | null {
  try {
    return tryOrcaDispatch(DISPATCH_MODULE, fn, input, {
      root: 'pairing',
      // zod `.optional()` cannot tell an absent key from an explicit
      // `undefined`, and `{...offer, scope: undefined}` is how callers spell
      // "no scope"; without this the codec rejects it and every such offer
      // silently takes the fallback.
      undefinedProperties: 'omit'
    })
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

export function encodePairingOffer(offer: PairingOffer, nowMs: number = Date.now()): string {
  // MEASURED, and the reason this validates before it dispatches. The encode
  // arm does not hand the core a JSON offer to validate — it REBUILDS a
  // `PairingOffer` struct field by field first (`offer_from_input` in
  // rust/crates/orca-dispatch/src/modules/pairing.rs), and its readers default:
  // `v`/`relay.v`/`relay.e2eeFraming` are `as_u64().unwrap_or(<the one legal
  // value>)`, `scope` is `as_str().and_then(from_str)` and a bad one becomes
  // absent, and a null `relay` is filtered to absent. So an offer the twin
  // REFUSES — `e2eeFraming: 'nope'`, `scope: 'desktop'`, `v: 3.5` — arrives
  // already repaired and the core mints a link for it. The sweep counts 221 such
  // offers in 7,522 inputs, every one that shape and all in the ACCEPT
  // direction, on the value that tells a phone which relay to trust — the one
  // direction this migration will not take. The PORT is not at fault
  // (`encode_pairing_offer` validates properly); the adapter that feeds it is,
  // and rebuilding the shipped wasm/napi is out of scope here, so the guard is
  // the boundary.
  //
  // So the offer is validated HERE, by the same body the unbound seam runs, and
  // only the VALIDATED offer crosses — which also keeps an unread sibling key
  // from failing the encode (a lone surrogate on a key zod strips would).
  const validated = validateOfferAt(offer, nowMs)
  const answer = dispatchPairing('encodePairingOffer', { nowMs, offer: validated })
  return answer === null ? legacyEncodeValidatedOffer(validated) : (answer as string)
}

export function decodePairingOffer(url: string, nowMs: number = Date.now()): PairingOffer {
  // The twin read `url.length` and then `new URL(url)`, so a non-string throws
  // or routes through the parser; the core's adapter reads a non-string as the
  // EMPTY STRING and answers "no code", a divergence only visible once bound.
  // Deep links arrive from `process.argv`, an Electron `open-url` event and the
  // relay wire, so a non-string is reachable.
  if (typeof url !== 'string') {
    return legacyDecodePairingOffer(url, nowMs)
  }
  const answer = dispatchPairing('decodePairingOffer', { nowMs, url })
  return answer === null ? legacyDecodePairingOffer(url, nowMs) : (answer as PairingOffer)
}

export function parsePairingCode(input: string, nowMs: number = Date.now()): PairingOffer | null {
  // Same reason, and here the twin's `.trim()` sits OUTSIDE its try/catch: a
  // non-string throws a TypeError rather than answering null, and this is the
  // clipboard-paste entry point.
  if (typeof input !== 'string') {
    return legacyParsePairingCode(input, nowMs)
  }
  const answer = dispatchPairing('parsePairingCode', { nowMs, input })
  return answer === null ? legacyParsePairingCode(input, nowMs) : (answer as PairingOffer)
}

/** The deleted twin's body, verbatim over the kept cap, from `JSON.stringify`
 *  onward — its `PairingOfferSchema.parse` step is `validateOfferAt`, which the
 *  caller has already run because its rejection must never reach the core. */
function legacyEncodeValidatedOffer(offer: PairingOffer): string {
  const json = JSON.stringify(offer)
  const base64url = Buffer.from(json, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  if (base64url.length > PAIRING_CODE_MAX_CHARACTERS) {
    throw new Error('Pairing offer exceeds safe size')
  }
  // Why: Android camera intents and Expo Router preserve query params more
  // reliably than URL fragments when launching a custom-scheme app.
  return `orca://pair?code=${base64url}`
}

/** The deleted twin's body, verbatim over the kept cap. */
function legacyDecodePairingOffer(url: string, nowMs: number): PairingOffer {
  if (url.length > PAIRING_INPUT_MAX_CHARACTERS) {
    throw new Error('Invalid pairing URL: pairing code exceeds safe size')
  }
  const code = extractPairingCodeFromUrl(url)
  if (!code) {
    throw new Error('Invalid pairing URL: must start with orca://pair and include a pairing code')
  }
  return decodePairingBase64(code, nowMs)
}

/** The deleted twin's body, verbatim over the kept cap. Accepts either an
 *  `orca://pair?...` URL or the bare base64 string, because the mobile
 *  paste-pair flow takes whichever the user actually copied from desktop. */
function legacyParsePairingCode(input: string, nowMs: number): PairingOffer | null {
  if (input.length > PAIRING_INPUT_MAX_CHARACTERS) {
    return null
  }
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  try {
    if (trimmed.toLowerCase().startsWith('orca://')) {
      return legacyDecodePairingOffer(trimmed, nowMs)
    }
    return decodePairingBase64(trimmed, nowMs)
  } catch {
    return null
  }
}

/** The deleted twin's body, verbatim over the kept route constants. */
function extractPairingCodeFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // Why: prefix checks accepted routes like `orca://pairing?...`; only the
  // pairing deep-link host may carry runtime auth material.
  if (
    parsed.protocol !== PAIRING_DEEP_LINK_PROTOCOL ||
    parsed.hostname !== PAIRING_DEEP_LINK_HOSTNAME
  ) {
    return null
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return null
  }
  const code = parsed.searchParams.get(PAIRING_DEEP_LINK_CODE_PARAM)
  if (code) {
    return code
  }
  return parsed.hash ? parsed.hash.slice(1) || null : null
}

/** The deleted twin's body over the kept cap and code pattern, plus residuals
 *  (2) and (3): serde_json parses the WHOLE document before any rule runs. */
function decodePairingBase64(base64url: string, nowMs: number): PairingOffer {
  if (
    base64url.length === 0 ||
    base64url.length > PAIRING_CODE_MAX_CHARACTERS ||
    !PAIRING_CODE_PATTERN.test(base64url)
  ) {
    throw new Error('Invalid pairing code')
  }
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const json = Buffer.from(base64, 'base64').toString('utf-8')
  const payload: unknown = JSON.parse(json)
  if (refusedBySerdeJson(payload)) {
    throw new Error(UNPORTABLE_PAYLOAD_REFUSAL)
  }
  return validateOfferAt(payload, nowMs)
}

/** The twin's `PairingOfferSchema.parse` at an INJECTED instant, plus residual
 *  (1). `.parse` throws, and the throw is the contract every caller branches on. */
function validateOfferAt(payload: unknown, nowMs: number): PairingOffer {
  const offer = createPairingOfferSchema(() => nowMs).parse(payload)
  if (hasPunycodeRelayLabel(offer)) {
    throw new Error(PUNYCODE_RELAY_REFUSAL)
  }
  return offer
}

/** Both relay origins already passed `isCanonicalHttpsOrigin`, so they are
 *  lowercase ASCII and `new URL` cannot throw; the host is compared label by
 *  label, matching the core's `!host.split('.').any(|l| l.starts_with("xn--"))`. */
function hasPunycodeRelayLabel(offer: PairingOffer): boolean {
  if (!offer.relay) {
    return false
  }
  return [offer.relay.directorUrl, offer.relay.cellUrl].some((origin) =>
    new URL(origin).hostname.split('.').some((label) => label.startsWith('xn--'))
  )
}

/** True when serde_json would refuse the document `JSON.parse` just accepted:
 *  a lone-surrogate escape in any string or key, or a number literal outside
 *  f64 range (the only way `JSON.parse` yields a non-finite number). */
function refusedBySerdeJson(value: unknown): boolean {
  if (typeof value === 'string') {
    return hasLoneSurrogate(value)
  }
  if (typeof value === 'number') {
    return !Number.isFinite(value)
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (Array.isArray(value)) {
    return value.some((entry) => refusedBySerdeJson(entry))
  }
  return Object.entries(value).some(
    ([key, entry]) => hasLoneSurrogate(key) || refusedBySerdeJson(entry)
  )
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true
      }
      index++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}
