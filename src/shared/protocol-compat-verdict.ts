// Runtime/mobile protocol-compat verdicts, evaluated by
// `orca_core::protocol_compat` over the shared dispatch seam. The twin
// (`src/shared/protocol-compat.ts`) keeps the verdict TYPES only.
//
// On the seam rather than a surface binding because the callers span three
// trees and no single binding reaches them all: `src/shared`
// (`execution-host-registry`), the renderer (the runtime-RPC compatibility gate,
// RuntimeEnvironmentsPane, automation targets, background work-item create) and
// the CLI (`runtime/client.ts`).
//
// PRE-READY CONTRACT — `parity`, and it is mandatory. Every caller is a GATE and
// BOTH wrong answers are severe: a pre-ready "ok" drives RPCs at a server that
// has already said it refuses this client, and a pre-ready "blocked" (or a null
// the callers would each have to fold into one) disables every remote host —
// `awaitGitWasmReadyForStartupHydration()` gates hydration, so an unbound seam
// after mount means the wasm FAILED, i.e. for the rest of the session, not for a
// few ms. There is no third state a verdict consumer could branch on that is not
// one of those two, so the fallback recomputes the deleted twin's body — plain
// comparisons over versions the caller passes in, no data table — and is the
// twin's answer for every input.
//
// WHY SOME INPUTS ARE ANSWERED LOCALLY EVEN WITH THE SEAM BOUND. The dispatch
// adapter reads each version with serde_json's `as_i64`, which answers None for a
// number that is not an integer or that JSON.stringify writes in exponent form
// (`1e+21`), and the core then reads the field as ABSENT, i.e. protocol 0. These
// versions are peer-supplied and unvalidated — `unwrapRuntimeRpcResult<RuntimeStatus>`
// is a cast over the wire JSON, not a schema — and the coercion is fail-OPEN on
// the one field that exists to fence old clients: measured, a server reporting
// `minCompatibleRuntimeClientVersion: 3.5` blocks in TS and CONNECTS through the
// core. So anything that is not a safe integer never crosses; it is answered by
// the same local body the unbound seam uses, which is the twin's answer.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import type { CompatVerdict, RuntimeCompatVerdict } from './protocol-compat'

const PROTOCOL_COMPAT = 'protocol-compat'

type RuntimeCompatInput = {
  clientProtocolVersion: number
  minCompatibleServerProtocolVersion: number
  serverProtocolVersion: number | undefined
  serverMinCompatibleClientProtocolVersion: number | undefined
}

type MobileCompatInput = {
  mobileProtocolVersion: number
  minCompatibleDesktopVersion: number
  desktopProtocolVersion: number | undefined
  desktopMinCompatibleMobileVersion: number | undefined
}

/** True when the core reads this version as the same value TypeScript compares. */
function crossesAsInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)
}

/** The two wire-supplied fields: absent and null both mean protocol 0 on both sides. */
function absentOrCrossesAsInteger(value: unknown): boolean {
  return value === undefined || value === null || crossesAsInteger(value)
}

/** `null` = the seam is unbound, or the payload cannot cross; either way the
 *  caller answers locally. A real verdict is never null. */
function dispatchCompat(fn: string, input: unknown, root: string): unknown {
  try {
    // Absent ≡ undefined for this module: the twin coalesces both with `?? 0`
    // and the adapter reads a missing key as `None`, then 0.
    return tryOrcaDispatch(PROTOCOL_COMPAT, fn, input, {
      undefinedProperties: 'omit',
      root
    })
  } catch (error) {
    // A wire version can be NaN/±Infinity/-0, which the codec refuses to encode.
    // The twin answered those without crossing, so the local body does too.
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

function localRuntimeCompat(input: RuntimeCompatInput): RuntimeCompatVerdict {
  const serverProtocolVersion = input.serverProtocolVersion ?? 0
  const requiredClientProtocolVersion = input.serverMinCompatibleClientProtocolVersion ?? 0

  if (input.clientProtocolVersion < requiredClientProtocolVersion) {
    return {
      kind: 'blocked',
      reason: 'client-too-old',
      clientProtocolVersion: input.clientProtocolVersion,
      serverProtocolVersion,
      requiredClientProtocolVersion
    }
  }
  if (serverProtocolVersion < input.minCompatibleServerProtocolVersion) {
    return {
      kind: 'blocked',
      reason: 'server-too-old',
      clientProtocolVersion: input.clientProtocolVersion,
      serverProtocolVersion,
      requiredServerProtocolVersion: input.minCompatibleServerProtocolVersion
    }
  }
  return {
    kind: 'ok',
    clientProtocolVersion: input.clientProtocolVersion,
    serverProtocolVersion
  }
}

function localDescribeRuntimeCompatBlock(verdict: RuntimeCompatVerdict): string {
  if (verdict.kind === 'ok') {
    return 'Runtime client and server are compatible.'
  }
  if (verdict.reason === 'client-too-old') {
    return `This Orca client is too old for the selected server. Update Orca on this machine. Client protocol ${verdict.clientProtocolVersion}, server requires client protocol ${verdict.requiredClientProtocolVersion}.`
  }
  return `The selected Orca server is too old for this client. Update Orca on the server. Server protocol ${verdict.serverProtocolVersion}, client requires server protocol ${verdict.requiredServerProtocolVersion}.`
}

function localMobileCompat(input: MobileCompatInput): CompatVerdict {
  const desktopVersion = input.desktopProtocolVersion ?? 0
  const requiredMobile = input.desktopMinCompatibleMobileVersion ?? 0

  if (input.mobileProtocolVersion < requiredMobile) {
    return {
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion,
      requiredMobileVersion: requiredMobile
    }
  }
  if (desktopVersion < input.minCompatibleDesktopVersion) {
    return {
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion,
      requiredDesktopVersion: input.minCompatibleDesktopVersion
    }
  }
  return { kind: 'ok' }
}

/**
 * Client-vs-server runtime protocol verdict. Absent server fields are protocol
 * 0, so a new client gives an old server "update the server" instead of
 * attempting partially-supported RPCs.
 */
export function evaluateRuntimeCompat(input: RuntimeCompatInput): RuntimeCompatVerdict {
  if (
    crossesAsInteger(input.clientProtocolVersion) &&
    crossesAsInteger(input.minCompatibleServerProtocolVersion) &&
    absentOrCrossesAsInteger(input.serverProtocolVersion) &&
    absentOrCrossesAsInteger(input.serverMinCompatibleClientProtocolVersion)
  ) {
    const verdict = dispatchCompat('evaluateRuntimeCompat', input, 'compat')
    if (verdict !== null) {
      return verdict as RuntimeCompatVerdict
    }
  }
  return localRuntimeCompat(input)
}

/** The user-facing sentence for a verdict; "compatible" for an `ok` one. */
export function describeRuntimeCompatBlock(verdict: RuntimeCompatVerdict): string {
  // Only the two numbers this reason interpolates matter, and both must be
  // present: the twin prints a missing one as "undefined", the core as "0".
  const interpolated =
    verdict.kind === 'ok'
      ? true
      : verdict.reason === 'client-too-old'
        ? crossesAsInteger(verdict.clientProtocolVersion) &&
          crossesAsInteger(verdict.requiredClientProtocolVersion)
        : crossesAsInteger(verdict.serverProtocolVersion) &&
          crossesAsInteger(verdict.requiredServerProtocolVersion)
  if (interpolated) {
    const message = dispatchCompat('describeRuntimeCompatBlock', verdict, 'verdict')
    if (message !== null) {
      return message as string
    }
  }
  return localDescribeRuntimeCompatBlock(verdict)
}

/**
 * Mobile-vs-desktop protocol verdict. `mobile-too-old` wins precedence: a
 * desktop refusing this mobile build (the kill switch) outranks mobile's own
 * judgment of the desktop's age. `mobile/src/transport/protocol-compat.ts` is
 * the Expo-side copy — that tree cannot import this one — and this entry stays
 * the desktop-side reference the parity vectors pin them both against.
 */
export function evaluateCompat(input: MobileCompatInput): CompatVerdict {
  if (
    crossesAsInteger(input.mobileProtocolVersion) &&
    crossesAsInteger(input.minCompatibleDesktopVersion) &&
    absentOrCrossesAsInteger(input.desktopProtocolVersion) &&
    absentOrCrossesAsInteger(input.desktopMinCompatibleMobileVersion)
  ) {
    const verdict = dispatchCompat('evaluateCompat', input, 'compat')
    if (verdict !== null) {
      return verdict as CompatVerdict
    }
  }
  return localMobileCompat(input)
}
