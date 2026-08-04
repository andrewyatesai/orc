import { resolveDiagnosticBuildIdentity } from '../observability/diagnostic-upload-endpoint'

// Why fail-closed: this is a fork of public Orca. The vendor's endpoints
// (onorca.dev) must never receive fork feedback or crash reports — they would
// deliver fork-internal diagnostics to an external party's inbox. The endpoint
// is a compile-time build constant (electron-vite `define`, like
// ORCA_POSTHOG_WRITE_KEY); builds without one return a typed
// 'endpoint-not-configured' result instead of falling back to any hardcoded
// host. Module-local ambient declaration because the constant is only read here.
declare const ORCA_FEEDBACK_ENDPOINT: string | null

export const FEEDBACK_ENDPOINT_NOT_CONFIGURED = 'endpoint-not-configured'

function resolveBuildFeedbackEndpoint(): string | null {
  // The `globalThis` dance mirrors telemetry/client.ts: compile-time
  // substitution in production, safe undefined in vitest (which lets tests
  // inject an endpoint via `globalThis`).
  const endpoint =
    typeof ORCA_FEEDBACK_ENDPOINT !== 'undefined'
      ? ORCA_FEEDBACK_ENDPOINT
      : ((globalThis as { ORCA_FEEDBACK_ENDPOINT?: string | null }).ORCA_FEEDBACK_ENDPOINT ?? null)
  return typeof endpoint === 'string' && endpoint.length > 0 ? endpoint : null
}

export function resolveFeedbackEndpoint(): string | null {
  const buildEndpoint = resolveBuildFeedbackEndpoint()
  // Why: official builds stay pinned to the CI-substituted endpoint; user env
  // cannot redirect reports the UI labels as going to the Orca fork team.
  // Dev/contributor builds may point at a scratch server via env — the same
  // rule diagnostic-upload-endpoint.ts applies to ORCA_DIAGNOSTICS_TOKEN_URL.
  if (resolveDiagnosticBuildIdentity()) {
    return buildEndpoint
  }
  const fromEnv = process.env.ORCA_FEEDBACK_ENDPOINT
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv
  }
  return buildEndpoint
}
