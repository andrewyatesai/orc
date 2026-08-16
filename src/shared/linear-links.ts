import { requireOrcaDispatch } from './orca-dispatch-seam'

// The three linear.app URL BUILDERS were cut over to `orca_core::linear_links`
// and now live in `./linear-app-urls.ts` on the orca-dispatch seam. What stays
// here is the data those fallbacks compose, plus the two URL PARSERS — see
// `getLinearOrganizationUrlKeyFromIssueUrl` for why one of them is refused.

/** Deep-link root every builder composes; also the host the parsers accept. */
export const LINEAR_APP_ORIGIN = 'https://linear.app'
export const LINEAR_APP_HOSTNAME = 'linear.app'

/** The answers the builders give when no workspace slug is known. */
export const LINEAR_GLOBAL_PERSONAL_API_KEY_SETTINGS_URL = `${LINEAR_APP_ORIGIN}/settings/account/security`
export const LINEAR_GLOBAL_WORKSPACE_API_SETTINGS_URL = `${LINEAR_APP_ORIGIN}/settings/api`

/**
 * The workspace url-key (first path segment) of a `linear.app` issue URL.
 *
 * NOT CUT OVER — refused 2026-08-15, and the reason is measured, not stylistic.
 * `orca_core::linear_links::parse_absolute_url` is a hand-rolled stand-in for
 * `new URL`, and the two disagree on six classes that a 48,325-case differential
 * against BOTH shipped artifacts turned up: `new URL` percent-ENCODES the
 * pathname (`/acme inc/…` → `acme%20inc`, `/café/…` → `caf%C3%A9`) where the
 * core returns the raw segment; it STRIPS tab/LF/CR anywhere in the input where
 * the core keeps them; it percent-decodes and IDNA-maps the HOST, so
 * `https://linear%2eapp/x/issue/ENG-1` and `https://linear.app<U+200B>/…` are
 * linear.app to the twin and not-linear.app to the core; it lower-cases the host
 * only for SPECIAL schemes, so `foo://LINEAR.APP/evil/issue/ENG-1` is refused
 * here and ACCEPTED by the core; it rejects `file://host:443/…` the core parses;
 * and it accepts the scheme-relative `https:/linear.app/…` the core refuses.
 *
 * This value is PERSISTED — `buildLinearWorkspaceSource` puts it in
 * `linearOrganizationUrlKey`, which rides `createWorktree` into the worktree
 * record's `linkedLinearIssueOrganizationUrlKey` — and
 * `main/linear/issue-context-current.ts` equality-compares it against
 * `workspace.organizationUrlKey` to pick which connected Linear org (and hence
 * which API token) answers for that workspace. Widening it to accept a
 * non-linear.app URL is the wrong-workspace outcome this module exists to avoid,
 * so the cut-over waits on a faithful `new URL` port plus a blob rebuild.
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
// KNOWN GAP, measured 2026-08-15: `parse_absolute_url` is NOT `new URL` — the
// six classes listed on `getLinearOrganizationUrlKeyFromIssueUrl` above apply
// here too (1,009 divergences in the same sweep), and this function's input is
// raw CLI/user text rather than a Linear-minted URL, so it is the more reachable
// of the two. Its `organizationUrlKey` is persisted the same way. Closing it
// means porting WHATWG URL parsing and rebuilding both artifacts.
export function parseLinearIssueInput(input: string): ParsedLinearIssueInput | null {
  return requireOrcaDispatch(
    'linear-links',
    'parseLinearIssueInput',
    input
  ) as ParsedLinearIssueInput | null
}
