// Wire-level handshake helpers for the Orca relay.

import { dirname, join } from 'node:path'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import type { Socket } from 'node:net'
import {
  RELAY_VERSION,
  MessageType,
  FrameDecoder,
  encodeHandshakeFrame,
  parseHandshakeMessage,
  type DecodedFrame
} from './protocol'
import {
  RELAY_CLI_ROLE_METHODS,
  isRelayAuthVerifier,
  relayAuthTokenMatchesVerifier,
  type RelayAuthRole
} from '../shared/ssh-relay-auth-token'
import { relayLogLine } from './relay-diagnostic-log'
import type { PreAuthConnectionGate } from './relay-pre-auth-connection-gate'

// Why: client maps this exit code to a non-retryable error so it skips reconnect backoff; other non-zero exits are treated as transient.
export const EXIT_CODE_VERSION_MISMATCH = 42

// Why: deliberately NOT terminal like 42. A rejected credential means the daemon
// on that socket is not ours (or is keyed to a secret this host no longer holds),
// and launchRelay's existing "socket reconnect failed" path reaps it and starts a
// fresh relay with the current verifier — self-healing instead of a dead target.
export const EXIT_CODE_AUTH_DENIED = 43

/** SHA-256 verifiers the daemon was launched with; it never sees either secret. */
export type RelayAuthVerifiers = {
  control: string
  cli?: string
}

// Why: read .version next to the resolved script path (realpathSync, not cwd) so arbitrary-cwd or symlink-launched spawns still report a coherent version.
export function readLaunchVersion(): string {
  try {
    const entry = process.argv[1]
    let dir: string
    if (entry) {
      let resolved = entry
      try {
        resolved = realpathSync(entry)
      } catch {
        /* fall back to the unresolved path */
      }
      dir = dirname(resolved)
    } else {
      dir = process.cwd()
    }
    const versionFile = join(dir, '.version')
    if (existsSync(versionFile)) {
      const v = readFileSync(versionFile, 'utf-8').trim()
      if (v) {
        return v
      }
    }
  } catch {
    /* fall through */
  }
  return RELAY_VERSION
}

// ── Daemon side ─────────────────────────────────────────────────────

export type DaemonHandshakeCallbacks = {
  // leftover: bytes buffered after the handshake frame; caller must feed the dispatcher before attaching the data listener or they're lost.
  onAccepted: (sock: Socket, leftover: Buffer, role: RelayAuthRole) => void
  launchVersion: string
  auth: RelayAuthVerifiers
  // Required, not optional: a caller that forgets it hands every silent peer an unbounded socket.
  preAuth: PreAuthConnectionGate
}

// Why: read one handshake frame before attaching the dispatcher; an unauthenticated
// or mismatched-version peer never reaches a verb.
export function setupDaemonHandshake(sock: Socket, cb: DaemonHandshakeCallbacks): void {
  let handshakeResolved = false
  cb.preAuth.track(sock)
  const decoder: FrameDecoder = new FrameDecoder(
    (frame: DecodedFrame) => {
      if (handshakeResolved) {
        return
      }
      const role = handleDaemonHandshakeFrame(sock, frame, cb.launchVersion, cb.auth)
      if (role) {
        handshakeResolved = true
        cb.preAuth.release(sock)
        const leftover = decoder.drain()
        detachHandshakeListener(sock)
        cb.onAccepted(sock, leftover, role)
      }
    },
    (err) => {
      process.stderr.write(`[relay] Handshake decode error: ${err.message}\n`)
      sock.destroy()
    }
  )

  const onHandshakeData = (chunk: Buffer): void => {
    // Why: a peer that has sent bytes is mid-handshake; one that has sent none is
    // the shape a flood takes. The gate sheds the silent first.
    cb.preAuth.noteSpoke(sock)
    decoder.feed(chunk)
  }
  sock.on('data', onHandshakeData)
  ;(sock as Socket & { __orcaOnHandshake?: typeof onHandshakeData }).__orcaOnHandshake =
    onHandshakeData
}

export function detachHandshakeListener(sock: Socket): void {
  const tagged = sock as Socket & { __orcaOnHandshake?: (chunk: Buffer) => void }
  if (tagged.__orcaOnHandshake) {
    sock.removeListener('data', tagged.__orcaOnHandshake)
    delete tagged.__orcaOnHandshake
  }
}

// Why: the socket mode is a remote-uid boundary and this channel reaches back to
// the user's laptop, so the credential is checked before anything else — an
// unauthenticated peer learns nothing, not even the daemon's version.
function resolveHandshakeRole(token: unknown, auth: RelayAuthVerifiers): RelayAuthRole | null {
  if (relayAuthTokenMatchesVerifier(token, auth.control)) {
    return 'control'
  }
  if (auth.cli !== undefined && relayAuthTokenMatchesVerifier(token, auth.cli)) {
    return 'cli'
  }
  return null
}

function denyHandshake(sock: Socket, reason: string): null {
  relayLogLine(`[relay] Handshake denied: ${reason}`)
  try {
    sock.write(encodeHandshakeFrame({ type: 'orca-relay-handshake-denied', reason: 'auth' }))
  } catch {
    /* best-effort — the close is what enforces the refusal */
  }
  sock.end()
  return null
}

function handleDaemonHandshakeFrame(
  sock: Socket,
  frame: DecodedFrame,
  launchVersion: string,
  auth: RelayAuthVerifiers
): RelayAuthRole | null {
  if (frame.type !== MessageType.Handshake) {
    process.stderr.write(
      `[relay] Protocol violation pre-handshake: type=${frame.type}; closing socket\n`
    )
    sock.destroy()
    return null
  }
  let msg: ReturnType<typeof parseHandshakeMessage>
  try {
    msg = parseHandshakeMessage(frame.payload)
  } catch (err) {
    relayLogLine(`[relay] Could not parse handshake: ${(err as Error).message}; closing socket`)
    sock.destroy()
    return null
  }
  if (msg.type !== 'orca-relay-handshake') {
    relayLogLine(`[relay] Unexpected handshake type from client: ${msg.type}; closing socket`)
    sock.destroy()
    return null
  }
  // Why: fail closed rather than serve everyone. A daemon launched without a
  // verifier cannot have been launched by a host that expects authentication.
  if (!isRelayAuthVerifier(auth.control)) {
    return denyHandshake(sock, 'daemon has no control verifier — refusing every client')
  }
  const role = resolveHandshakeRole(msg.token, auth)
  if (!role) {
    return denyHandshake(
      sock,
      msg.token === undefined ? 'client presented no token' : 'client presented a bad token'
    )
  }
  if (msg.version !== launchVersion) {
    relayLogLine(
      `[relay] Handshake mismatch: own=${launchVersion}, client=${msg.version}; closing socket`
    )
    try {
      sock.write(
        encodeHandshakeFrame({
          type: 'orca-relay-handshake-mismatch',
          expected: launchVersion,
          got: msg.version
        })
      )
    } catch {
      /* best-effort — close+exit-42 still wins */
    }
    sock.end()
    return null
  }
  process.stderr.write(`[relay] Handshake OK from version=${msg.version} role=${role}\n`)
  // Why: `auth` proves nothing to the client (any peer can assert it), but a
  // MISSING one is fatal there — it is how a relay build that does not
  // authenticate gets refused. So it must be sent, and it is not a credential.
  sock.write(
    encodeHandshakeFrame({
      type: 'orca-relay-handshake-ok',
      version: launchVersion,
      auth: 'verified'
    })
  )
  return role
}

/** Methods a client of this role may call; `undefined` means the full surface. */
export function allowedMethodsForRole(role: RelayAuthRole): readonly string[] | undefined {
  return role === 'cli' ? RELAY_CLI_ROLE_METHODS : undefined
}

// ── --connect side ──────────────────────────────────────────────────

export type ConnectHandshakeCallbacks = {
  // leftover: bytes buffered after handshake-ok; caller must forward to stdout before attaching the bridge or they're dropped.
  onAccepted: (leftover: Buffer) => void
}

// Why: bridge-side auth + version handshake; defense-in-depth so a bad .version can't let a v2 bridge drive a v1 daemon (cf. VS Code remoteExtensionHostAgentServer.ts:340).
export function runConnectHandshake(
  sock: Socket,
  myVersion: string,
  token: string,
  cb: ConnectHandshakeCallbacks
): void {
  let handshakeDone = false

  const decoder: FrameDecoder = new FrameDecoder(
    (frame: DecodedFrame) => {
      if (handshakeDone) {
        return
      }
      if (frame.type !== MessageType.Handshake) {
        process.stderr.write(
          `[relay-connect] Protocol violation: expected Handshake frame, got type=${frame.type}\n`
        )
        sock.destroy()
        process.exit(1)
      }
      let msg: ReturnType<typeof parseHandshakeMessage>
      try {
        msg = parseHandshakeMessage(frame.payload)
      } catch (err) {
        process.stderr.write(
          `[relay-connect] Could not parse handshake reply: ${(err as Error).message}\n`
        )
        sock.destroy()
        process.exit(1)
      }
      if (msg.type === 'orca-relay-handshake-ok') {
        // Why: `auth` is the peer's own claim — a downgrade guard, not proof of
        // identity. It refuses a relay build that does not authenticate; an
        // impostor just asserts 'verified', and our token went out before either
        // branch is reached. Whoever can write the remote install dir owns
        // relay.js, the uploaded node and this socket path alike, so there is no
        // ceremony to add here: D1.4 in docs/reference/orca-daemon-authority-model.md.
        if (msg.auth !== 'verified') {
          process.stderr.write(
            `[relay-connect] Daemon accepted the handshake without verifying our token; ` +
              `refusing to drive an unauthenticated relay. Exiting ${EXIT_CODE_AUTH_DENIED}\n`,
            () => {
              sock.destroy()
              process.exit(EXIT_CODE_AUTH_DENIED)
            }
          )
          return
        }
        process.stderr.write(`[relay-connect] Handshake OK at version=${msg.version}\n`)
        handshakeDone = true
        const leftover = decoder.drain()
        sock.removeAllListeners('data')
        cb.onAccepted(leftover)
        return
      }
      if (msg.type === 'orca-relay-handshake-denied') {
        process.stderr.write(
          `[relay-connect] Relay rejected our credential (reason=${msg.reason}); exiting ${EXIT_CODE_AUTH_DENIED}\n`,
          () => {
            sock.destroy()
            process.exit(EXIT_CODE_AUTH_DENIED)
          }
        )
        return
      }
      if (msg.type === 'orca-relay-handshake-mismatch') {
        // Why: exit inside the write callback; stderr is async on pipe transports, so exiting early drops the version detail.
        process.stderr.write(
          `[relay-connect] Handshake mismatch: expected=${msg.expected}, daemon=${msg.got}; exiting ${EXIT_CODE_VERSION_MISMATCH}\n`,
          () => {
            sock.destroy()
            process.exit(EXIT_CODE_VERSION_MISMATCH)
          }
        )
        return
      }
      process.stderr.write(`[relay-connect] Unexpected handshake type: ${msg.type}\n`)
      sock.destroy()
      process.exit(1)
    },
    (err) => {
      process.stderr.write(`[relay-connect] Handshake decode error: ${err.message}\n`)
      sock.destroy()
      process.exit(1)
    }
  )

  sock.on('data', (chunk: Buffer) => {
    if (!handshakeDone) {
      decoder.feed(chunk)
    }
  })

  sock.write(encodeHandshakeFrame({ type: 'orca-relay-handshake', version: myVersion, token }))
}
