// The pairing offer's types and wire constants.
//
// CUT OVER to `orca_relay::pairing`. The `orca://pair?code=` codec that lived
// here — `encodePairingOffer`, `decodePairingOffer`, `parsePairingCode` — is
// DELETED; every caller reaches it through `src/shared/pairing-deep-link.ts` on
// the orca-dispatch seam, whose pre-ready fallback rebuilds the deleted bodies
// out of exactly the constants below plus `createPairingOfferSchema`. Validation
// still belongs to the sibling `mobile-relay-pairing-offer.ts`, which this file
// re-exports and which owns every field rule.
import {
  PAIRING_OFFER_VERSION,
  PairingOfferSchema,
  type PairingOffer
} from './mobile-relay-pairing-offer'

export { PAIRING_OFFER_VERSION, PairingOfferSchema }
export type { PairingOffer }

/** `orca://pair?code=…` — the exact deep-link route. A prefix check accepted
 *  `orca://pairing?...`; only this host may carry runtime auth material. */
export const PAIRING_DEEP_LINK_PROTOCOL = 'orca:'
export const PAIRING_DEEP_LINK_HOSTNAME = 'pair'
export const PAIRING_DEEP_LINK_CODE_PARAM = 'code'

/** The shape a pairing code must have before it is base64-decoded. Both
 *  alphabets are accepted, and padding is only legal at the END — the decoder
 *  alone stops at the first `=`, which let `<valid-code>=junk` through. */
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/
