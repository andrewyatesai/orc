// Attributes an `orca.cli` call to the pane it was made from.
//
// The shim runs inside a pane, so the association exists physically — it just
// wasn't carried, and the host imported whatever identity the payload named.
// The relay spawns every pane, so it mints a per-PTY token into that pane's
// spawn env and keeps only the token's verifier. A call proves which pane it is
// by presenting the token; the identity it acts under is then read from the
// relay's own record of that PTY, never from the call.
//
// Bound, honestly: the token lives in a pane environment, so an actor who can
// already read another pane's environ on the remote can act as that pane. What
// this closes is identity *selection* — a caller can no longer name a pane it
// cannot produce the token for, so a scraped credential stays confined to the
// pane it was scraped from instead of unlocking every pane on the relay.

import { randomBytes } from 'node:crypto'
import {
  isRelayAuthSecret,
  relayAuthTokenMatchesVerifier,
  relayAuthVerifier
} from '../shared/ssh-relay-auth-token'
import {
  REMOTE_CLI_IDENTITY_ENV_VARS,
  remoteCliCallerIdentityFromPaneEnv,
  type RemoteCliCallerIdentity
} from '../shared/ssh-remote-cli-identity'

/** Carries a pane's attribution token into its shell, and into every child of it. */
export const RELAY_PANE_TOKEN_ENV = 'ORCA_RELAY_PANE_TOKEN'

/** Wire field on `orca.cli` params holding the caller's pane token. */
export const ORCA_CLI_PANE_TOKEN_PARAM = 'paneToken'

// Why: the token is minted while building a spawn env, so a pty.spawn that then
// throws leaves a record no exit event will ever release. Bound the map; panes
// are already capped far below this.
const MAX_TRACKED_PANES = 256

type PaneRecord = {
  ptyId: string
  verifier: string
  identity: RemoteCliCallerIdentity
}

export class RelayPaneCliAttribution {
  private readonly panes = new Map<string, PaneRecord>()

  /** Spawn-env contribution for one PTY; re-issuing (revive) revokes the old token. */
  issue(ptyId: string, paneEnv: Record<string, string | undefined>): Record<string, string> {
    const token = randomBytes(32).toString('hex')
    this.panes.set(ptyId, {
      ptyId,
      verifier: relayAuthVerifier(token),
      identity: remoteCliCallerIdentityFromPaneEnv(paneEnv)
    })
    // Insertion order is age order, so the oldest record sheds first.
    while (this.panes.size > MAX_TRACKED_PANES) {
      const oldest = this.panes.keys().next()
      if (oldest.done) {
        break
      }
      this.panes.delete(oldest.value)
    }
    return { [RELAY_PANE_TOKEN_ENV]: token }
  }

  /** A dead pane's token must stop working the moment the PTY is gone. */
  release(ptyId: string): void {
    this.panes.delete(ptyId)
  }

  resolve(token: unknown): RemoteCliCallerIdentity | null {
    if (!isRelayAuthSecret(token)) {
      return null
    }
    for (const record of this.panes.values()) {
      if (relayAuthTokenMatchesVerifier(token, record.verifier)) {
        return record.identity
      }
    }
    return null
  }
}

export type OrcaCliPaneBinding = {
  /** Params to forward: caller identity replaced by the attributed one. */
  params: Record<string, unknown>
  /** Set when the payload named a pane the caller could not prove it owns. */
  rejectedPaneKey?: string
}

/**
 * Rewrites `orca.cli` params so the pane identity that reaches the host is the
 * relay's, not the caller's. An unattributable call keeps working with no pane
 * identity at all rather than with the one it asked for.
 */
export function bindOrcaCliPaneIdentity(
  params: Record<string, unknown>,
  attribution: Pick<RelayPaneCliAttribution, 'resolve'>
): OrcaCliPaneBinding {
  const identity = attribution.resolve(params[ORCA_CLI_PANE_TOKEN_PARAM]) ?? {}
  const claimedEnv =
    params.env && typeof params.env === 'object' && !Array.isArray(params.env)
      ? (params.env as Record<string, unknown>)
      : undefined
  const env: Record<string, unknown> = { ...claimedEnv }
  for (const key of REMOTE_CLI_IDENTITY_ENV_VARS) {
    delete env[key]
  }
  const claimedPaneKey = claimedEnv?.ORCA_PANE_KEY
  const bound: Record<string, unknown> = { ...params, env, identity }
  // Why: the host has no use for the pane credential, and forwarding a secret
  // past the point it is checked only widens where it can leak.
  delete bound[ORCA_CLI_PANE_TOKEN_PARAM]
  return {
    params: bound,
    ...(typeof claimedPaneKey === 'string' &&
    claimedPaneKey.length > 0 &&
    claimedPaneKey !== identity.paneKey
      ? { rejectedPaneKey: claimedPaneKey }
      : {})
  }
}
