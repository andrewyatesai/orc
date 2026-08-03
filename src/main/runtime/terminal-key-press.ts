/**
 * `terminal.key` — press one key on a pane, the way a human would.
 *
 * The verb the collapsed-output problem needs. When an agent TUI prints
 * `… +N lines`, those lines were never written to the terminal, so no read can
 * recover them from the pane; the only way to see them there is to press the key
 * the agent binds for expansion. That is a write, and a write to a pane someone
 * else may be typing into, so it goes through the SAME machinery
 * `terminal.submitAgentPrompt` does — §5.1's input lease and §5.4's human
 * preemption. There is no second write path here that skips them.
 *
 * The order is deliberate:
 *
 *  1. **Yield to a human on a phone first**, before even asking for the lease:
 *     the coordinator arbitrates automated writers, and they are not one (§5.4).
 *  2. **Lease the pane**, which validates the pinned incarnation.
 *  3. **Encode UNDER the lease.** Not before it: the bytes a key means are a
 *     function of the pane's live modes, and encoding while another writer may
 *     still be mid-paste would read a mode set that is about to change. This is
 *     also where every "cannot encode" answer is produced, and each one is a
 *     named refusal rather than an empty write.
 *  4. **Arm, then write once.** `armSubmit()` is the linearization point the
 *     lease already provides for "the keystroke is about to land"; a human claim
 *     that arrives after it lands on the right row of §5.4's table. The whole
 *     keystroke — press and, under the Kitty protocol, release — is ONE write,
 *     so a refusal can never leave half a chord in the pane.
 *
 * What this module deliberately does NOT do is verify. There is no evidence
 * channel for "the TUI acted on Ctrl+R" the way there is for a submitted prompt:
 * no hook fires, no agent state transitions. Rather than invent a verdict, the
 * result reports exactly what it knows — bytes accepted — and declares the gap.
 * `terminal.screen` is the oracle; a driver reads it before and after.
 *
 * Pure module — no Electron, no PTY I/O; every side effect arrives as a port.
 */
import {
  TERMINAL_KEY_BLIND_SPOTS,
  TERMINAL_KEY_SCHEMA_VERSION,
  escapeTerminalKeyBytes,
  namedKeyboardModeFlags,
  type TerminalKeyEvents,
  type TerminalKeyModifierName,
  type TerminalKeyRefusalCode,
  type TerminalKeyResult
} from '../../shared/terminal-key-protocol'
import type {
  EmulatorKeyEncodingRead,
  EmulatorKeyEncodingRequest
} from '../daemon/emulator-key-encoding'
import type { SubmitClock } from './agent-prompt-submit-verification'
import {
  transitionUnderHeldAuthority,
  type WriteAuthorityWait
} from './agent-prompt-write-authority'
import type {
  AcquireInputLeaseRequest,
  AcquireInputLeaseResult,
  TerminalInputLease
} from './terminal-input-coordinator'
import type { AutomatedWriter, ConnectionPin } from './terminal-input-lease-preemption'

export type TerminalKeyPressTarget = {
  handle: string
  ptyId: string
  pin: ConnectionPin
}

export type TerminalKeyPressRequest = {
  target: TerminalKeyPressTarget
  /** A DOM `KeyboardEvent.key` value — resolve spellings with
   *  `shared/terminal-key-names.ts` before calling. */
  key: string
  modifiers: TerminalKeyModifierName[]
  /** Engine `Modifiers` bitfield for `modifiers`. */
  modifierBits: number
  writer: AutomatedWriter
  signal?: AbortSignal
}

export type TerminalKeyPressPorts = {
  acquireLease(request: AcquireInputLeaseRequest): Promise<AcquireInputLeaseResult>
  /** True while a human drives this pane from a phone (§5.4's human floor). */
  humanDriverHoldsPane?(ptyId: string): boolean
  /** Null when this pane has no live headless engine at all — its modes are
   *  unknown, and encoding against a guess is the failure this verb exists to
   *  avoid. */
  encodeKey(ptyId: string, request: EmulatorKeyEncodingRequest): EmulatorKeyEncodingRead | null
  /** The same PTY write `terminal.send` and the submit primitive use.
   *  False means the terminal refused the bytes. */
  write(ptyId: string, data: string): boolean
  clock: SubmitClock
}

const REFUSAL_REASONS: Record<TerminalKeyRefusalCode, string> = {
  'unknown-key': 'the terminal engine has no key by that name',
  'not-encodable': 'that key produces no bytes in this pane’s current keyboard modes',
  'no-headless-engine':
    'this pane has no live engine, so its keyboard modes are unknown and the encoding would be a guess',
  'engine-unavailable': 'the engine for this pane could not encode the key',
  'addon-too-old': 'this build has no key-encoding binding',
  'pty-disposed': 'the terminal is no longer running',
  'generation-change': 'the terminal was replaced by a newer incarnation before the key was sent',
  cancelled: 'the caller cancelled before the key was sent',
  'mobile-driver-active': 'a person is driving this terminal from a phone',
  preempted: 'a person took the keyboard before the key was sent',
  'human-claim-undecided':
    'a human input claim reserved the pane and neither committed nor rolled back',
  'write-refused': 'the terminal refused the key’s bytes'
}

/** Every lease refusal maps onto a key refusal of the same name — the vocabulary
 *  is the coordinator's, not this verb's. */
const LEASE_REFUSAL_CODES: Record<
  'cancelled' | 'generation-change' | 'pty-disposed',
  TerminalKeyRefusalCode
> = {
  cancelled: 'cancelled',
  'generation-change': 'generation-change',
  'pty-disposed': 'pty-disposed'
}

function baseResult(request: TerminalKeyPressRequest, now: number): TerminalKeyResult {
  return {
    schema: TERMINAL_KEY_SCHEMA_VERSION,
    handle: request.target.handle,
    ptyId: request.target.ptyId,
    key: request.key,
    modifiers: request.modifiers,
    sent: false,
    bytes: null,
    byteLength: 0,
    events: 'none',
    modes: null,
    operationId: null,
    decidedAt: now,
    blindSpots: [...TERMINAL_KEY_BLIND_SPOTS]
  }
}

function refused(
  request: TerminalKeyPressRequest,
  code: TerminalKeyRefusalCode,
  ports: TerminalKeyPressPorts,
  detail: Partial<TerminalKeyResult> = {}
): TerminalKeyResult {
  return {
    ...baseResult(request, ports.clock.now()),
    ...detail,
    refusal: { code, reason: REFUSAL_REASONS[code] }
  }
}

/** The encode step's answer: bytes to write, or the refusal that replaced them.
 *  Both carry the modes when they are known, because "this key means nothing
 *  here" is only useful alongside what "here" was. */
type KeyEncodeOutcome =
  | { ok: true; data: string; byteLength: number; escaped: string; events: TerminalKeyEvents }
  | { ok: false; code: TerminalKeyRefusalCode }

function encodeUnderLease(
  request: TerminalKeyPressRequest,
  ports: TerminalKeyPressPorts
): { outcome: KeyEncodeOutcome; modes: TerminalKeyResult['modes'] } {
  const read = ports.encodeKey(request.target.ptyId, {
    key: request.key,
    modifierBits: request.modifierBits
  })
  if (!read) {
    return { outcome: { ok: false, code: 'no-headless-engine' }, modes: null }
  }
  if (read.outcome === 'unsupported') {
    return { outcome: { ok: false, code: 'addon-too-old' }, modes: null }
  }
  if (read.outcome === 'unreadable') {
    return { outcome: { ok: false, code: 'engine-unavailable' }, modes: null }
  }
  const { encoding } = read
  const modes = {
    modeBits: encoding.modeBits,
    flags: namedKeyboardModeFlags(encoding.modeBits),
    // Named, not implied: this is the replay's model of the pane, and the
    // encoding below inherits whatever drift it carries.
    source: 'runtime-headless-replay' as const
  }
  if (!encoding.recognized) {
    return { outcome: { ok: false, code: 'unknown-key' }, modes }
  }
  if (encoding.press.length === 0) {
    return { outcome: { ok: false, code: 'not-encodable' }, modes }
  }
  // One buffer, one write: a chord that reached the pane as a press without its
  // release would leave a Kitty-speaking app believing the key is held down.
  const bytes = Buffer.concat([encoding.press, encoding.release])
  return {
    outcome: {
      ok: true,
      // UTF-8 because that is what the engine emitted and what the PTY write
      // path re-encodes; escape sequences are ASCII, and a character key that
      // is not round-trips exactly.
      data: bytes.toString('utf8'),
      byteLength: bytes.length,
      escaped: escapeTerminalKeyBytes(bytes),
      events: encoding.release.length > 0 ? 'press+release' : 'press'
    },
    modes
  }
}

export async function pressTerminalKey(
  request: TerminalKeyPressRequest,
  ports: TerminalKeyPressPorts
): Promise<TerminalKeyResult> {
  const { target } = request
  // Before the lease, not after: a pane a person is typing into from a phone is
  // not available to automation, whatever the coordinator would say.
  if (ports.humanDriverHoldsPane?.(target.ptyId) === true) {
    return refused(request, 'mobile-driver-active', ports)
  }
  const acquired = await ports.acquireLease({
    ptyId: target.ptyId,
    pin: target.pin,
    writer: request.writer,
    ...(request.signal ? { signal: request.signal } : {})
  })
  if (!acquired.ok) {
    return refused(request, LEASE_REFUSAL_CODES[acquired.reason], ports)
  }
  try {
    return await pressUnderLease(request, ports, acquired.lease)
  } finally {
    acquired.lease.release()
  }
}

async function pressUnderLease(
  request: TerminalKeyPressRequest,
  ports: TerminalKeyPressPorts,
  lease: TerminalInputLease
): Promise<TerminalKeyResult> {
  const held = { operationId: lease.operationId }
  const { outcome, modes } = encodeUnderLease(request, ports)
  if (!outcome.ok) {
    return refused(request, outcome.code, ports, { ...held, modes })
  }
  const wait: WriteAuthorityWait = {
    clock: ports.clock,
    ...(request.signal ? { signal: request.signal } : {})
  }
  // The lease's own pre-keypress latch: past it, a human claim is a preemption
  // report rather than a race over who wrote what.
  const armed = await transitionUnderHeldAuthority(lease, wait, () => lease.armSubmit())
  if (armed.kind !== 'held') {
    // 'revoked' is the pane being taken; 'abandoned' is this keystroke giving it
    // up. Both wrote nothing, and a caller retrying them wants to know which.
    return refused(request, armed.kind === 'revoked' ? 'preempted' : armed.code, ports, {
      ...held,
      modes
    })
  }
  if (!ports.write(request.target.ptyId, outcome.data)) {
    return refused(request, 'write-refused', ports, { ...held, modes })
  }
  return {
    ...baseResult(request, ports.clock.now()),
    ...held,
    sent: true,
    bytes: outcome.escaped,
    byteLength: outcome.byteLength,
    events: outcome.events,
    modes
  }
}
