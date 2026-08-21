// Pre-ready contract rows (rule + machinery:
// ./shim-pre-ready-contract-harness.ts) for device pairing deep links and
// protocol compatibility verdicts.
import {
  encodePairingOffer,
  parsePairingCode,
  type PairingOffer
} from '../../../../shared/pairing-deep-link'
import {
  describeRuntimeCompatBlock,
  evaluateCompat,
  evaluateRuntimeCompat
} from '../../../../shared/protocol-compat-verdict'
import { runShimPreReadyContractSuite } from './shim-pre-ready-contract-harness'
import type { PreReadyCase } from './shim-pre-ready-contract-harness'

const CASES: PreReadyCase[] = [
  // Parity is mandatory for all four rows and no sentinel exists: these are the
  // compatibility GATES. A pre-ready "ok" drives every runtime RPC at a server
  // that already said it refuses this client; a pre-ready "blocked" (or a null
  // each caller folds into one) strands every remote host for the session, since
  // an unbound seam after hydration means the wasm FAILED. Both directions of
  // evaluateRuntimeCompat are pinned because the fallback reproduces the twin's
  // body, not a constant.
  {
    name: 'protocol-compat-verdict.evaluateRuntimeCompat(compatible)',
    call: () =>
      evaluateRuntimeCompat({
        clientProtocolVersion: 3,
        minCompatibleServerProtocolVersion: 2,
        serverProtocolVersion: 3,
        serverMinCompatibleClientProtocolVersion: 2
      }),
    contract: {
      kind: 'parity',
      why: "the fallback re-runs the twin's comparisons over the versions the caller passes in — a pre-ready block would disable the host"
    }
  },
  {
    name: 'protocol-compat-verdict.evaluateRuntimeCompat(client-too-old)',
    call: () =>
      evaluateRuntimeCompat({
        clientProtocolVersion: 3,
        minCompatibleServerProtocolVersion: 2,
        serverProtocolVersion: 4,
        serverMinCompatibleClientProtocolVersion: 4
      }),
    contract: {
      kind: 'parity',
      why: 'the blocking direction: the server kill-switch must fire pre-ready exactly as ready, or an incompatible peer is connected'
    }
  },
  {
    name: 'protocol-compat-verdict.describeRuntimeCompatBlock(server-too-old)',
    call: () =>
      describeRuntimeCompatBlock({
        kind: 'blocked',
        reason: 'server-too-old',
        clientProtocolVersion: 3,
        serverProtocolVersion: 1,
        requiredServerProtocolVersion: 2
      }),
    contract: {
      kind: 'parity',
      why: 'the fallback interpolates the same sentence — this string is the whole error the user is shown, and it is thrown as an Error message'
    }
  },
  {
    name: 'protocol-compat-verdict.evaluateCompat(mobile-too-old)',
    call: () =>
      evaluateCompat({
        mobileProtocolVersion: 1,
        minCompatibleDesktopVersion: 0,
        desktopProtocolVersion: 5,
        desktopMinCompatibleMobileVersion: 2
      }),
    contract: {
      kind: 'parity',
      why: 'the desktop-side reference for the mobile protocol: same body, same kill-switch precedence, in both states'
    }
  },
  // Pairing deep links: parity ×3, forced, and every row passes an EXPLICIT
  // `nowMs`. The offer's invite window is wall-clock, so a row that let the shim
  // read the clock would compare the pre-ready pass and the ready pass at two
  // different instants and pass or fail on how long this file took to load. A
  // pairing offer names the relay a device will trust and is persisted into the
  // runtime-environment record, so no stand-in is admissible; the third row is
  // the declared IDN residual, whose REFUSAL has to be pre-ready too.
  {
    name: 'pairing-deep-link.encodePairingOffer(relay offer)',
    call: () => pairingOutcome(() => encodePairingOffer(PAIRING_RELAY_OFFER, PAIRING_NOW)),
    contract: {
      kind: 'parity',
      why: 'the fallback re-runs the kept schema at the SAME instant, so the minted link is byte-identical'
    }
  },
  {
    name: 'pairing-deep-link.parsePairingCode(relay code)',
    call: () => parsePairingCode(PAIRING_RELAY_CODE, PAIRING_NOW),
    contract: {
      kind: 'parity',
      why: 'the paste-pair entry point; its offer is written to disk, so a pre-ready guess becomes a trusted relay'
    }
  },
  {
    name: 'pairing-deep-link.encodePairingOffer(xn-- relay origin)',
    call: () =>
      pairingOutcome(() =>
        encodePairingOffer(
          {
            ...PAIRING_RELAY_OFFER,
            relay: { ...PAIRING_RELAY, cellUrl: 'https://xn--80ak6aa92e.com' }
          },
          PAIRING_NOW
        )
      ),
    contract: {
      kind: 'parity',
      why: 'the declared IDN residual: the core refuses it, so the fallback must refuse it rather than accept'
    }
  }
]

/** A fixed instant, and a relay offer minted at it. */
const PAIRING_NOW = 1_783_872_000_000
const PAIRING_RELAY: NonNullable<PairingOffer['relay']> = {
  v: 1,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  inviteToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678',
  inviteExpiresAt: PAIRING_NOW + 5 * 60 * 1000,
  e2eeFraming: 2
}
const PAIRING_RELAY_OFFER: PairingOffer = {
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  relay: PAIRING_RELAY
}
const PAIRING_RELAY_CODE = encodePairingOffer(PAIRING_RELAY_OFFER, PAIRING_NOW)

/** `encodePairingOffer` rejects by throwing; shape it into a comparable value. */
function pairingOutcome(call: () => unknown): { ok?: unknown; threw?: string } {
  try {
    return { ok: call() }
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) }
  }
}

runShimPreReadyContractSuite(CASES)
