// The three linear.app URL builders on the Rust `orca_core::linear_links` core.
// This sits on `orca-dispatch-seam` rather than in one tree's binding directory
// because the callers span two trees and no single binding reaches both: main
// mints `LinearTeam.url` for every team it fetches
// (`main/linear/linear-team-pages.ts`, napi) while the renderer builds the same
// team link from cached issue metadata (`TaskPage.tsx`) and both API-key
// settings links (`linear-api-key-dialog.tsx`, wasm at ready). The twin
// `src/shared/linear-links.ts` keeps the origin, the two global settings URLs
// and both URL PARSERS — `getLinearOrganizationUrlKeyFromIssueUrl` is refused
// rather than cut over, for the measured reason recorded in its header.
//
// SINKS — traced 2026-08-16, not assumed (an earlier revision of this header
// claimed "every return value is fed to `window.api.shell.openUrl`", which is
// true of the two settings URLs and NOT of the team URL). No built URL is
// PERSISTED: nothing here reaches settings, worktree metadata or a store on
// disk, and none is a Map or React key (teams key by `id`) or equality-compared.
// The team URL does travel further than openUrl, though — `LinearTeam.url` is
// re-fetched per request in main, held in the renderer's in-memory
// `linearTeamCache` and mobile React state, and surfaced to agents through
// `orca-runtime.linearTeamSummary`. Every read of it is a truthiness gate or an
// `openUrl`. Contrast the PARSERS in the twin, whose org key IS persisted —
// which is why they are held to a stricter bar there.
//
// PRE-READY CONTRACT — `parity` ×3, and it is FORCED, not chosen:
//  * A wrong URL opens someone else's Linear workspace.
//    `buildLinearPersonalApiKeySettingsUrl`
//    and `buildLinearWorkspaceApiSettingsUrl` are TOTAL — the global
//    `linear.app/settings/…` URL is the twin's REAL answer for a blank slug, so
//    returning it pre-ready is indistinguishable from an answer and silently
//    drops the user on the personal-default workspace's settings page instead of
//    the one the dialog says it is connecting.
//  * `buildLinearTeamUrl`'s `null` is likewise the twin's real "no key" answer,
//    and its ABSENCE is load-bearing: `linear-team-pages.ts` writes
//    `?? undefined` into `LinearTeam.url`, and `TaskPage.tsx` only offers the
//    "open team in Linear" action for a team that HAS a url — so a pre-ready
//    `null` is a dead action for the whole session on a failed core.
//  * No sentinel has anywhere to live, and lifting to a list does not help: each
//    answer is ONE link. So the fallbacks recompute the deleted twin's bodies
//    over the constants the twin keeps.
//
// MEASURED, not assumed: 80,103 fallback-vs-core comparisons against BOTH
// shipped artifacts (`orca_git_wasm_bg.wasm` and `orca_node.node`) — every ASCII
// code unit alone and embedded, plane-spanning scalars, all 25 JS-trim code
// points plus 8 look-alikes JS does NOT trim (U+0085, U+180E, U+200B, U+2060,
// U+00AD, Hangul fillers) leading/trailing/doubled/interior, every
// encodeURIComponent-reserved character, a 174x174 org x team cross product,
// 4,000 random multi-scalar keys and the null/undefined/absent argument
// shapes — 0 divergences. The corpus is discriminating, watched to fail: a Rust
// `char::is_whitespace` trim reddens 10 cases, `encodeURI` for
// `encodeURIComponent` 22, dropping the trim 125, testing emptiness on the raw
// value 50, dropping the blank-slug branch 51.
//
// Each fallback is computed EAGERLY, before the dispatch, because two input
// classes make the twin THROW and the core answer normally: a non-string slug
// (`5?.trim` is a TypeError; the adapter's `as_str` reads None and returns the
// global URL / null) and an unpaired UTF-16 surrogate (`encodeURIComponent`
// throws URIError; the payload cannot cross at all). Both reach here — a slug
// arrives from persisted settings, the Linear API and the relay wire.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import {
  LINEAR_APP_ORIGIN,
  LINEAR_GLOBAL_PERSONAL_API_KEY_SETTINGS_URL,
  LINEAR_GLOBAL_WORKSPACE_API_SETTINGS_URL
} from './linear-links'

const LINEAR_LINKS = 'linear-links'

/** `null` = the seam is unbound, or the payload cannot cross — answer locally.
 *  Unambiguous for the two settings builders (they always answer a string); for
 *  `buildLinearTeamUrl` the core's own `null` collapses onto the fallback's,
 *  which is safe only because this shim is `parity`. A lone surrogate in a team
 *  key that the twin never encoded (the other key was blank, so it returned
 *  `null` first) is the reachable rejection; a DispatchCoreError still
 *  propagates. */
function dispatchLinearUrl(fn: string, input: unknown, root: string): unknown {
  try {
    return tryOrcaDispatch(LINEAR_LINKS, fn, input, { root })
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return null
    }
    throw error
  }
}

/** The deleted twin's body, verbatim over the kept origin. */
function legacyBuildLinearTeamUrl(args: {
  organizationUrlKey?: string | null
  teamKey?: string | null
}): string | null {
  const organizationUrlKey = args.organizationUrlKey?.trim()
  const teamKey = args.teamKey?.trim()
  if (!organizationUrlKey || !teamKey) {
    return null
  }
  return `${LINEAR_APP_ORIGIN}/${encodeURIComponent(organizationUrlKey)}/team/${encodeURIComponent(teamKey)}/all`
}

/** The deleted twin's body, verbatim over the kept origin and global URL. */
function legacyBuildLinearPersonalApiKeySettingsUrl(organizationUrlKey?: string | null): string {
  const trimmed = organizationUrlKey?.trim()
  return trimmed
    ? `${LINEAR_APP_ORIGIN}/${encodeURIComponent(trimmed)}/settings/account/security`
    : LINEAR_GLOBAL_PERSONAL_API_KEY_SETTINGS_URL
}

/** The deleted twin's body, verbatim over the kept origin and global URL. */
function legacyBuildLinearWorkspaceApiSettingsUrl(organizationUrlKey?: string | null): string {
  const trimmed = organizationUrlKey?.trim()
  return trimmed
    ? `${LINEAR_APP_ORIGIN}/${encodeURIComponent(trimmed)}/settings/api`
    : LINEAR_GLOBAL_WORKSPACE_API_SETTINGS_URL
}

/**
 * `https://linear.app/<org>/team/<team>/all`, or `null` when either key is
 * blank — which `TaskPage` reads as "this team has no external link".
 */
export function buildLinearTeamUrl(args: {
  organizationUrlKey?: string | null
  teamKey?: string | null
}): string | null {
  // Eager, so a non-string key throws the twin's TypeError and a lone surrogate
  // its URIError, on both paths.
  const fallback = legacyBuildLinearTeamUrl(args)
  // `null` and an absent key are the same answer to the twin's optional chain
  // and to the adapter's `as_str`, so normalize rather than opt into `omit`.
  const answer = dispatchLinearUrl(
    'buildLinearTeamUrl',
    { organizationUrlKey: args.organizationUrlKey ?? null, teamKey: args.teamKey ?? null },
    'linearTeamUrlParts'
  )
  return answer === null ? fallback : (answer as string)
}

/** The Personal API key settings page, scoped to the workspace when its slug is
 *  known and the global page otherwise — the twin's own two answers. */
export function buildLinearPersonalApiKeySettingsUrl(organizationUrlKey?: string | null): string {
  const fallback = legacyBuildLinearPersonalApiKeySettingsUrl(organizationUrlKey)
  const answer = dispatchLinearUrl(
    'buildLinearPersonalApiKeySettingsUrl',
    organizationUrlKey ?? null,
    'organizationUrlKey'
  )
  return answer === null ? fallback : (answer as string)
}

/** The workspace API settings page, scoped the same way. */
export function buildLinearWorkspaceApiSettingsUrl(organizationUrlKey?: string | null): string {
  const fallback = legacyBuildLinearWorkspaceApiSettingsUrl(organizationUrlKey)
  const answer = dispatchLinearUrl(
    'buildLinearWorkspaceApiSettingsUrl',
    organizationUrlKey ?? null,
    'organizationUrlKey'
  )
  return answer === null ? fallback : (answer as string)
}
