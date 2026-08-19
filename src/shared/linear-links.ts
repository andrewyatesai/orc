import { requireOrcaDispatch } from './orca-dispatch-seam'

// STILL PARTIAL, and deliberately. The three linear.app URL BUILDERS were cut
// over to `orca_core::linear_links` and live in `./linear-app-urls.ts` on the
// orca-dispatch seam; what stays here is the data their fallbacks compose plus
// the two URL PARSERS. Those two are NOT symmetrical:
// `parseLinearIssueInput` is already a shim over the core — and, measured, it
// should not be; `getLinearOrganizationUrlKeyFromIssueUrl` is the only
// TypeScript implementation left, refused for the same root cause. Both headers
// below carry the measurement. The root cause is ONE function,
// `parse_absolute_url`, so both close together or neither does.

/** Deep-link root every builder composes; also the host the parsers accept. */
export const LINEAR_APP_ORIGIN = 'https://linear.app'
export const LINEAR_APP_HOSTNAME = 'linear.app'

/** The answers the builders give when no workspace slug is known. */
export const LINEAR_GLOBAL_PERSONAL_API_KEY_SETTINGS_URL = `${LINEAR_APP_ORIGIN}/settings/account/security`
export const LINEAR_GLOBAL_WORKSPACE_API_SETTINGS_URL = `${LINEAR_APP_ORIGIN}/settings/api`

/**
 * The workspace url-key (first path segment) of a `linear.app` issue URL.
 *
 * NOT CUT OVER — refused, and the reason is measured, not stylistic.
 * `orca_core::linear_links::parse_absolute_url` is a hand-rolled stand-in for
 * `new URL`; re-measured 2026-08-16 against the shipped `orca_node.node`, they
 * disagree on 145 of a 640-input sweep, in six classes. `new URL`
 * percent-ENCODES the pathname (`/acme inc/…` → `acme%20inc`, `/café/…` →
 * `caf%C3%A9`) where the core returns the raw segment; it STRIPS tab/LF/CR
 * anywhere in the input where the core keeps them; it percent-decodes and
 * IDNA-maps the HOST, so `https://linear%2eapp/x/issue/ENG-1` and
 * `https://linear.app<U+200B>/…` are linear.app to the twin and not-linear.app
 * to the core; it lower-cases the host only for SPECIAL schemes, so
 * `foo://LINEAR.APP/evil/issue/ENG-1` is refused here and ACCEPTED by the core;
 * it rejects `file://host:443/…` the core parses; and it accepts the
 * scheme-relative `https:/linear.app/…` the core refuses.
 * `linear-links.test.ts` pins one input per class; all six were watched to go
 * red when pointed at the core, so the guard is not vacuous.
 *
 * This value is PERSISTED — `buildLinearWorkspaceSource` puts it in
 * `linearOrganizationUrlKey`, which rides `createWorktree` into the worktree
 * record's `linkedLinearIssueOrganizationUrlKey` — and
 * `main/linear/issue-context-current.ts` equality-compares it against
 * `workspace.organizationUrlKey` to pick which connected Linear org (and hence
 * which API token) answers for that workspace. That makes the encoding classes
 * as disqualifying as the host ones: records already on disk hold the twin's
 * `caf%C3%A9`, the core would write and compare `café`, and neither side can
 * read the other's. So the cut-over waits on a faithful `new URL` port (no
 * `url`/`idna` crate is vendored — `parse_absolute_url` is this module's own)
 * plus a rebuild of both artifacts.
 */
export function getLinearOrganizationUrlKeyFromIssueUrl(issueUrl?: string | null): string | null {
  if (!issueUrl) {
    return null
  }
  try {
    const parsed = new URL(issueUrl)
    if (parsed.hostname !== LINEAR_APP_HOSTNAME) {
      return null
    }
    return parsed.pathname.split('/').find(Boolean) ?? null
  } catch {
    return null
  }
}

export type ParsedLinearIssueInput = {
  identifier: string
  organizationUrlKey?: string
}

// Parse a Linear issue identifier ("ENG-123") or issue URL into its identifier +
// org key. Single-sourced in the Rust core (orca_core::linear_links); this runs
// on main + the CLI (both bind the napi dispatch seam at bootstrap), so it uses
// requireOrcaDispatch. Rust mirrors JS `new URL`/decodeURIComponent/trim/toUpperCase
// via parse_absolute_url + try_decode_uri_component + trim_js.
//
// SHIPPED DIVERGENCE, re-measured 2026-08-16 against `orca_node.node`: 86 of the
// same 640-input sweep. FIVE of the six classes above reach here — only the
// pathname percent-encoding one cancels, because this function `decodeURIComponent`s
// the org key and undoes it. Two of the five WIDEN: `foo://LINEAR.APP/evil/issue/ENG-1`
// and `file://linear.app:443/acme/issue/ENG-1` are `null` to the twin and yield
// org keys `evil` / `acme` from the core. Unlike its neighbour above, this input is
// raw CLI/agent text (`orca worktree --linear-issue <value>`), and
// `cli/handlers/worktree-linear-issue-link.ts` writes the result straight to the
// persisted `linkedLinearIssueOrganizationUrlKey`, which
// `resolveLegacyLinearLinkWorkspace` then equality-matches against a connected
// workspace to pick an API token. That is the wrong-workspace path, so this is a
// defect to close, not a gap to tolerate: it needs the same faithful `new URL`
// port and artifact rebuild, and until then the twin above must NOT be cut over
// to the same `parse_absolute_url`.
export function parseLinearIssueInput(input: string): ParsedLinearIssueInput | null {
  return requireOrcaDispatch(
    'linear-links',
    'parseLinearIssueInput',
    input
  ) as ParsedLinearIssueInput | null
}
