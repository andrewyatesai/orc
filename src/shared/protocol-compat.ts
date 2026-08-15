// Why: the verdict TYPES for the protocol compatibility evaluators, shared
// between desktop tests, renderer runtime switching, the CLI and the mobile
// mirror. The evaluators themselves were cut over to `orca_core::protocol_compat`
// — call them through `src/shared/protocol-compat-verdict.ts`, which reaches the
// Rust core over the shared dispatch seam from every surface.

export type RuntimeCompatVerdict =
  | {
      kind: 'ok'
      clientProtocolVersion: number
      serverProtocolVersion: number
    }
  | {
      kind: 'blocked'
      reason: 'client-too-old' | 'server-too-old'
      clientProtocolVersion: number
      serverProtocolVersion: number
      requiredClientProtocolVersion?: number
      requiredServerProtocolVersion?: number
    }

export type CompatVerdict =
  | { kind: 'ok' }
  | {
      kind: 'blocked'
      reason: 'mobile-too-old' | 'desktop-too-old'
      desktopVersion: number
      requiredMobileVersion?: number
      requiredDesktopVersion?: number
    }
