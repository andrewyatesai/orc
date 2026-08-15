// Moved here from protocol-compat.test.ts with the twin's implementation: the
// evaluators now answer from `orca_core::protocol_compat` over the dispatch seam.
//
// The seam has TWO observable states — main/cli/relay bind at bootstrap, the
// renderer only once the wasm compiles (and never, if it fails) — and these are
// compatibility GATES, so both must answer identically: a wrong "ok" drives RPCs
// at a server that already refuses this client, a wrong "blocked" strands every
// remote host. The third state is the one the CORE forces: a version that is not
// a safe integer, which serde's `as_i64` reads as absent (protocol 0).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setOrcaDispatchBinding, type OrcaDispatchFn } from './orca-dispatch-seam'
import {
  describeRuntimeCompatBlock,
  evaluateCompat,
  evaluateRuntimeCompat
} from './protocol-compat-verdict'
import {
  DESKTOP_PROTOCOL_VERSION,
  MIN_COMPATIBLE_MOBILE_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from './protocol-version'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

const MOBILE_V = 1

const wasmDispatch: OrcaDispatchFn = (module, fn, inputJson) => orcaDispatch(module, fn, inputJson)

beforeEach(() => setOrcaDispatchBinding(wasmDispatch))
afterEach(() => setOrcaDispatchBinding(null))

describe('evaluateCompat', () => {
  it('returns ok when both desktop fields are undefined and constants are wide-open', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 0,
      desktopProtocolVersion: undefined,
      desktopMinCompatibleMobileVersion: undefined
    })
    expect(verdict).toEqual({ kind: 'ok' })
  })

  it('returns ok when desktop reports version equal to mobile', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 0,
      desktopProtocolVersion: MOBILE_V,
      desktopMinCompatibleMobileVersion: 0
    })
    expect(verdict).toEqual({ kind: 'ok' })
  })

  it('returns ok when desktop reports a newer version (additive changes assumed safe)', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 0,
      desktopProtocolVersion: MOBILE_V + 5,
      desktopMinCompatibleMobileVersion: 0
    })
    expect(verdict).toEqual({ kind: 'ok' })
  })

  it('allows desktop protocol 3 to roll out before mobile protocol 2 updates', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: 2,
      minCompatibleDesktopVersion: 2,
      desktopProtocolVersion: 3,
      desktopMinCompatibleMobileVersion: 2
    })

    expect(verdict).toEqual({ kind: 'ok' })
  })

  it('allows mobile protocol 3 to roll out before desktop protocol 2 updates', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: 3,
      minCompatibleDesktopVersion: 2,
      desktopProtocolVersion: 2,
      desktopMinCompatibleMobileVersion: 2
    })

    expect(verdict).toEqual({ kind: 'ok' })
  })

  it('blocks with mobile-too-old when desktop requires a newer mobile', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 0,
      desktopProtocolVersion: 5,
      desktopMinCompatibleMobileVersion: MOBILE_V + 1
    })
    expect(verdict).toEqual({
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion: 5,
      requiredMobileVersion: MOBILE_V + 1
    })
  })

  it('coerces undefined desktopVersion to 0 in the verdict payload', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 0,
      desktopProtocolVersion: undefined,
      desktopMinCompatibleMobileVersion: MOBILE_V + 1
    })
    expect(verdict).toMatchObject({
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion: 0
    })
  })

  it('blocks with desktop-too-old when desktop reports below the local minimum', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 5,
      desktopProtocolVersion: 3,
      desktopMinCompatibleMobileVersion: 0
    })
    expect(verdict).toEqual({
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion: 3,
      requiredDesktopVersion: 5
    })
  })

  it('mobile-too-old wins precedence when both constraints would fire', () => {
    // Why: documents the intended kill-switch precedence — desktop's
    // refusal of a too-old mobile takes priority over mobile's local
    // refusal of a too-old desktop.
    const verdict = evaluateCompat({
      mobileProtocolVersion: MOBILE_V,
      minCompatibleDesktopVersion: 99,
      desktopProtocolVersion: -1,
      desktopMinCompatibleMobileVersion: MOBILE_V + 1
    })
    expect(verdict.kind).toBe('blocked')
    expect((verdict as { reason: string }).reason).toBe('mobile-too-old')
  })

  it('with minCompatibleDesktopVersion = 0 every reported desktop passes', () => {
    for (const v of [0, 1, 2, 99]) {
      expect(
        evaluateCompat({
          mobileProtocolVersion: MOBILE_V,
          minCompatibleDesktopVersion: 0,
          desktopProtocolVersion: v,
          desktopMinCompatibleMobileVersion: 0
        })
      ).toEqual({ kind: 'ok' })
    }
  })

  it('hard-blocks protocol-1 mobile for the binary terminal stream cutover', () => {
    const verdict = evaluateCompat({
      mobileProtocolVersion: 1,
      minCompatibleDesktopVersion: DESKTOP_PROTOCOL_VERSION,
      desktopProtocolVersion: DESKTOP_PROTOCOL_VERSION,
      desktopMinCompatibleMobileVersion: MIN_COMPATIBLE_MOBILE_VERSION
    })

    expect(verdict).toEqual({
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion: DESKTOP_PROTOCOL_VERSION,
      requiredMobileVersion: MIN_COMPATIBLE_MOBILE_VERSION
    })
  })
})

describe('evaluateRuntimeCompat', () => {
  it('keeps the current client and current server self-compatible', () => {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
      serverProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      serverMinCompatibleClientProtocolVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    })

    expect(verdict).toMatchObject({ kind: 'ok' })
  })

  it('allows client and server app versions to skew when protocol ranges overlap', () => {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
      serverProtocolVersion: RUNTIME_PROTOCOL_VERSION + 3,
      serverMinCompatibleClientProtocolVersion: RUNTIME_PROTOCOL_VERSION - 1
    })

    expect(verdict).toMatchObject({ kind: 'ok' })
  })

  it('blocks when the server requires a newer client protocol', () => {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION,
      serverProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1,
      serverMinCompatibleClientProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1
    })

    expect(verdict).toMatchObject({
      kind: 'blocked',
      reason: 'client-too-old',
      requiredClientProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1
    })
    expect(describeRuntimeCompatBlock(verdict)).toContain('client is too old')
  })

  it('blocks when the server protocol is below the client minimum', () => {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      serverProtocolVersion: RUNTIME_PROTOCOL_VERSION - 1,
      serverMinCompatibleClientProtocolVersion: 0
    })

    expect(verdict).toMatchObject({
      kind: 'blocked',
      reason: 'server-too-old',
      requiredServerProtocolVersion: RUNTIME_PROTOCOL_VERSION
    })
    expect(describeRuntimeCompatBlock(verdict)).toContain('server is too old')
  })

  it('treats missing server fields as protocol 0', () => {
    const verdict = evaluateRuntimeCompat({
      clientProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleServerProtocolVersion: 1,
      serverProtocolVersion: undefined,
      serverMinCompatibleClientProtocolVersion: undefined
    })

    expect(verdict).toMatchObject({
      kind: 'blocked',
      reason: 'server-too-old',
      serverProtocolVersion: 0
    })
  })
})

// The two wire-supplied fields, as the runtime RPC gate reads them off a peer's
// status.get. Expectations are the DELETED twin's answers, transcribed from its
// body — the unbound seam must reproduce them, and so must the bound one.
const RUNTIME_WIRE_CASES: readonly (readonly [number | undefined, number | undefined, unknown])[] =
  [
    [3, 2, { kind: 'ok', clientProtocolVersion: 3, serverProtocolVersion: 3 }],
    [
      undefined,
      undefined,
      {
        kind: 'blocked',
        reason: 'server-too-old',
        clientProtocolVersion: 3,
        serverProtocolVersion: 0,
        requiredServerProtocolVersion: 2
      }
    ],
    [
      1,
      0,
      {
        kind: 'blocked',
        reason: 'server-too-old',
        clientProtocolVersion: 3,
        serverProtocolVersion: 1,
        requiredServerProtocolVersion: 2
      }
    ],
    [
      4,
      4,
      {
        kind: 'blocked',
        reason: 'client-too-old',
        clientProtocolVersion: 3,
        serverProtocolVersion: 4,
        requiredClientProtocolVersion: 4
      }
    ],
    [
      -1,
      0,
      {
        kind: 'blocked',
        reason: 'server-too-old',
        clientProtocolVersion: 3,
        serverProtocolVersion: -1,
        requiredServerProtocolVersion: 2
      }
    ],
    [
      0,
      0,
      {
        kind: 'blocked',
        reason: 'server-too-old',
        clientProtocolVersion: 3,
        serverProtocolVersion: 0,
        requiredServerProtocolVersion: 2
      }
    ]
  ]

const runtimeVerdict = (
  serverProtocolVersion: number | undefined,
  serverMinCompatibleClientProtocolVersion: number | undefined
): unknown =>
  evaluateRuntimeCompat({
    clientProtocolVersion: 3,
    minCompatibleServerProtocolVersion: 2,
    serverProtocolVersion,
    serverMinCompatibleClientProtocolVersion
  })

describe('protocol-compat verdicts (orca-dispatch seam)', () => {
  it('answers the same unbound and bound', () => {
    setOrcaDispatchBinding(null)
    const unbound = RUNTIME_WIRE_CASES.map(([server, required]) => runtimeVerdict(server, required))

    setOrcaDispatchBinding(wasmDispatch)
    const bound = RUNTIME_WIRE_CASES.map(([server, required]) => runtimeVerdict(server, required))

    expect(unbound).toEqual(RUNTIME_WIRE_CASES.map(([, , expected]) => expected))
    expect(bound).toEqual(unbound)
  })

  it('reaches the Rust core for an in-contract call, and not for a guarded one', () => {
    const calls: string[] = []
    setOrcaDispatchBinding((module, fn, inputJson) => {
      calls.push(`${module}.${fn}`)
      return wasmDispatch(module, fn, inputJson)
    })

    runtimeVerdict(3, 2)
    expect(calls).toEqual(['protocol-compat.evaluateRuntimeCompat'])

    // Not a safe integer: the guard keeps it local, so nothing new crosses.
    runtimeVerdict(3, 3.5)
    expect(calls).toEqual(['protocol-compat.evaluateRuntimeCompat'])
  })
})

// The core reads each version with serde_json's `as_i64`, which answers None for
// a non-integral number or one JSON.stringify writes in exponent form, and the
// adapter then treats the field as ABSENT — protocol 0. On
// serverMinCompatibleClientProtocolVersion that is FAIL-OPEN: the server's
// refusal of this client disappears. These rows plant exactly that and assert the
// shim did not dispatch them: each expects the twin's answer AND that the raw core
// disagrees, so the day the core learns to read them the second half turns red and
// the guard gets re-derived instead of silently outliving its reason.
const rawCore = (fn: string, input: unknown): unknown =>
  JSON.parse(orcaDispatch('protocol-compat', fn, JSON.stringify(input)))

describe('versions the Rust core cannot read are answered locally', () => {
  it.each([
    ['fractional required-client (kill switch)', 3, 3.5],
    ['exponent-form required-client', 3, 1e21],
    ['fractional server protocol', 1.5, 0],
    ['exponent-form server protocol', 1e21, 0]
  ])('%s', (_label, server, required) => {
    const input = {
      clientProtocolVersion: 3,
      minCompatibleServerProtocolVersion: 2,
      serverProtocolVersion: server,
      serverMinCompatibleClientProtocolVersion: required
    }
    // The twin's body, for this input.
    const serverVersion = server ?? 0
    const twin =
      3 < (required ?? 0)
        ? {
            kind: 'blocked',
            reason: 'client-too-old',
            clientProtocolVersion: 3,
            serverProtocolVersion: serverVersion,
            requiredClientProtocolVersion: required ?? 0
          }
        : serverVersion < 2
          ? {
              kind: 'blocked',
              reason: 'server-too-old',
              clientProtocolVersion: 3,
              serverProtocolVersion: serverVersion,
              requiredServerProtocolVersion: 2
            }
          : { kind: 'ok', clientProtocolVersion: 3, serverProtocolVersion: serverVersion }

    expect(evaluateRuntimeCompat(input)).toEqual(twin)
    expect(rawCore('evaluateRuntimeCompat', input)).not.toEqual(twin)
  })

  it('keeps a fractional desktop kill-switch blocking on the mobile evaluator too', () => {
    const input = {
      mobileProtocolVersion: 2,
      minCompatibleDesktopVersion: 2,
      desktopProtocolVersion: 3,
      desktopMinCompatibleMobileVersion: 2.5
    }
    const twin = {
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion: 3,
      requiredMobileVersion: 2.5
    }

    expect(evaluateCompat(input)).toEqual(twin)
    expect(rawCore('evaluateCompat', input)).toEqual({ kind: 'ok' })
  })

  it('formats a verdict the core would misread with the twin numbers', () => {
    // The core prints an unreadable or missing number as 0; the twin printed the
    // value, or the literal "undefined". Both messages are shown to the user.
    const fractional = {
      kind: 'blocked',
      reason: 'client-too-old',
      clientProtocolVersion: 3,
      serverProtocolVersion: 4,
      requiredClientProtocolVersion: 3.5
    } as const
    expect(describeRuntimeCompatBlock(fractional)).toContain('requires client protocol 3.5.')
    expect(rawCore('describeRuntimeCompatBlock', fractional)).toContain(
      'requires client protocol 0.'
    )

    const missing = {
      kind: 'blocked',
      reason: 'client-too-old',
      clientProtocolVersion: 3,
      serverProtocolVersion: 4
    } as const
    expect(describeRuntimeCompatBlock(missing)).toContain('requires client protocol undefined.')
  })

  it('answers a codec-refused version instead of throwing at the gate', () => {
    // NaN/±Infinity/-0 cannot be encoded at all (JSON.stringify writes null for
    // the first two and loses the sign of the third), so the codec refuses the
    // payload. The twin answered them without crossing, and so does this.
    expect(runtimeVerdict(Number.NaN, 0)).toEqual({
      kind: 'ok',
      clientProtocolVersion: 3,
      serverProtocolVersion: Number.NaN
    })
    expect(runtimeVerdict(Number.POSITIVE_INFINITY, 0)).toEqual({
      kind: 'ok',
      clientProtocolVersion: 3,
      serverProtocolVersion: Number.POSITIVE_INFINITY
    })
    expect(runtimeVerdict(-0, 0)).toMatchObject({
      kind: 'blocked',
      reason: 'server-too-old'
    })
  })
})
