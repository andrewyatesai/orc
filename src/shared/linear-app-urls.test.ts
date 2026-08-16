// The linear-links twin's builder suites, moved onto the seam shim when the
// three URL builders were cut over to `orca_core::linear_links`. Every case runs
// TWICE — seam unbound (the renderer before wasm init, the preload, mobile, a
// Playwright spec) and bound to the wasm core (main/cli via napi, the relay via
// initSync) — because every one of these strings is handed to
// `window.api.shell.openUrl`, so a pre-ready value that merely looks like a URL
// opens the wrong Linear workspace.
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildLinearPersonalApiKeySettingsUrl,
  buildLinearTeamUrl,
  buildLinearWorkspaceApiSettingsUrl
} from './linear-app-urls'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

/** Run `call` unbound and bound; assert both equal `expected`. */
function bothStates<T>(call: () => T, expected: T): void {
  setOrcaDispatchBinding(null)
  expect(call()).toEqual(expected)
  bindWasm()
  expect(call()).toEqual(expected)
}

/** Run `assert` unbound and again bound, for throw expectations. */
function inBothStates(assert: () => void): void {
  setOrcaDispatchBinding(null)
  assert()
  bindWasm()
  assert()
}

/** The raw core answer, with no shim guard in the way. */
function rawCore(fn: string, input: unknown): unknown {
  return JSON.parse(orcaDispatch('linear-links', fn, JSON.stringify(input)))
}

afterEach(() => setOrcaDispatchBinding(null))

describe('linear app URL builders', () => {
  it('builds team URLs from workspace and team keys', () => {
    bothStates(
      () => buildLinearTeamUrl({ organizationUrlKey: 'acme', teamKey: 'ENG' }),
      'https://linear.app/acme/team/ENG/all'
    )
  })

  it('encodes URL path segments', () => {
    bothStates(
      () => buildLinearTeamUrl({ organizationUrlKey: 'acme inc', teamKey: 'A/B' }),
      'https://linear.app/acme%20inc/team/A%2FB/all'
    )
  })

  it('builds organization-scoped API key settings URLs', () => {
    bothStates(
      () => buildLinearPersonalApiKeySettingsUrl('acme inc'),
      'https://linear.app/acme%20inc/settings/account/security'
    )
    bothStates(
      () => buildLinearWorkspaceApiSettingsUrl('acme/inc'),
      'https://linear.app/acme%2Finc/settings/api'
    )
  })

  it('falls back to global API settings URLs when no organization slug is available', () => {
    bothStates(
      () => buildLinearPersonalApiKeySettingsUrl(),
      'https://linear.app/settings/account/security'
    )
    bothStates(() => buildLinearWorkspaceApiSettingsUrl('   '), 'https://linear.app/settings/api')
  })

  it('treats null, undefined and an absent key as the same missing slug', () => {
    bothStates(() => buildLinearWorkspaceApiSettingsUrl(null), 'https://linear.app/settings/api')
    bothStates(() => buildLinearTeamUrl({ organizationUrlKey: 'acme' }), null)
    bothStates(() => buildLinearTeamUrl({ organizationUrlKey: 'acme', teamKey: null }), null)
    bothStates(() => buildLinearTeamUrl({}), null)
  })

  // The JS trim set, not Rust's: JS strips U+FEFF and keeps U+0085, so a slug
  // carrying either must resolve the same way on both paths.
  it('trims with the ECMAScript whitespace set', () => {
    bothStates(
      () => buildLinearWorkspaceApiSettingsUrl('\u{FEFF}acme\u{FEFF}'),
      'https://linear.app/acme/settings/api'
    )
    bothStates(
      () => buildLinearWorkspaceApiSettingsUrl('\u{FEFF}'),
      'https://linear.app/settings/api'
    )
    bothStates(
      () => buildLinearWorkspaceApiSettingsUrl('\u{85}'),
      'https://linear.app/%C2%85/settings/api'
    )
  })
})

describe('linear app URL builder boundary guards', () => {
  // Slugs arrive from persisted settings, the Linear API and the relay wire, so
  // the type is not a guarantee. Eager fallback => the twin's TypeError on both
  // paths; the raw core answers a plausible URL instead, which is the divergence
  // this guard exists to stop.
  it('throws the twin TypeError for a non-string slug in both states', () => {
    inBothStates(() => {
      expect(() => buildLinearPersonalApiKeySettingsUrl(5 as unknown as string)).toThrow(TypeError)
      expect(() =>
        buildLinearTeamUrl({ organizationUrlKey: 5 as unknown as string, teamKey: 'ENG' })
      ).toThrow(TypeError)
    })
    expect(rawCore('buildLinearPersonalApiKeySettingsUrl', 5)).toBe(
      'https://linear.app/settings/account/security'
    )
    expect(rawCore('buildLinearTeamUrl', { organizationUrlKey: 5, teamKey: 'ENG' })).toBeNull()
  })

  // encodeURIComponent throws on an unpaired surrogate, and the payload cannot
  // cross the seam at all, so the eager fallback has to be the one that answers.
  it('throws the twin URIError for an unpaired surrogate in both states', () => {
    inBothStates(() => {
      expect(() => buildLinearWorkspaceApiSettingsUrl('\uD800')).toThrow(URIError)
      expect(() => buildLinearTeamUrl({ organizationUrlKey: 'acme', teamKey: 'a\uD800b' })).toThrow(
        URIError
      )
    })
  })

  // The one surrogate case the twin answered WITHOUT encoding: the other key is
  // blank, so it returned null first. The codec still refuses the payload, so
  // the DispatchPayloadError catch is what keeps the answer equal.
  it('answers null for an unpaired surrogate the twin never encoded', () => {
    bothStates(() => buildLinearTeamUrl({ organizationUrlKey: '', teamKey: '\uD800' }), null)
    bothStates(() => buildLinearTeamUrl({ organizationUrlKey: '\uD800', teamKey: '  ' }), null)
  })
})
