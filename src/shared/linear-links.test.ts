// The two URL PARSERS. The builder suites moved to `linear-app-urls.test.ts`
// with the cut-over; `getLinearOrganizationUrlKeyFromIssueUrl` is still
// TypeScript on purpose (see its header), so its cases stay here.
import { describe, expect, it } from 'vitest'

import { getLinearOrganizationUrlKeyFromIssueUrl, parseLinearIssueInput } from './linear-links'

describe('linear links', () => {
  it('extracts the workspace URL key from Linear issue URLs', () => {
    expect(getLinearOrganizationUrlKeyFromIssueUrl('https://linear.app/acme/issue/ENG-1')).toBe(
      'acme'
    )
  })

  it('parses bare Linear issue identifiers', () => {
    expect(parseLinearIssueInput('eng-123')).toEqual({ identifier: 'ENG-123' })
  })

  it('parses Linear issue URLs with organization URL keys', () => {
    expect(parseLinearIssueInput('https://linear.app/acme/issue/eng-123/fix-auth')).toEqual({
      identifier: 'ENG-123',
      organizationUrlKey: 'acme'
    })
    expect(parseLinearIssueInput('https://linear.app/stably/issue/STA-335/test-issue')).toEqual({
      identifier: 'STA-335',
      organizationUrlKey: 'stably'
    })
  })

  it('rejects non-Linear issue input', () => {
    expect(parseLinearIssueInput('https://example.com/acme/issue/ENG-123')).toBeNull()
    expect(parseLinearIssueInput('not an issue')).toBeNull()
  })

  // One input per divergence class in the refusal on the function — each was
  // measured to get a DIFFERENT answer from the shipped core, so wiring this to
  // `parse_absolute_url` turns these red instead of silently rewriting a
  // persisted `linkedLinearIssueOrganizationUrlKey`.
  it('keeps the WHATWG-normalized answer the Rust parse does not reproduce', () => {
    // Pathname re-encoded (core: 'acme inc').
    expect(getLinearOrganizationUrlKeyFromIssueUrl('https://linear.app/acme inc/issue/ENG-1')).toBe(
      'acme%20inc'
    )
    // Tab stripped anywhere in the input (core: 'ac\tme').
    expect(getLinearOrganizationUrlKeyFromIssueUrl('https://linear.app/ac\tme/issue/ENG-1')).toBe(
      'acme'
    )
    // Host percent-decoded (core: null).
    expect(getLinearOrganizationUrlKeyFromIssueUrl('https://linear%2eapp/acme/issue/ENG-1')).toBe(
      'acme'
    )
    // Scheme-relative single slash accepted (core: null).
    expect(getLinearOrganizationUrlKeyFromIssueUrl('https:/linear.app/acme/issue/ENG-1')).toBe(
      'acme'
    )
    // The two WIDENINGS — the core answers where the twin refuses.
    // Host case-folded only for special schemes (core: 'evil').
    expect(getLinearOrganizationUrlKeyFromIssueUrl('foo://LINEAR.APP/evil/issue/ENG-1')).toBeNull()
    // A port makes a file: URL unparseable (core: 'acme').
    expect(
      getLinearOrganizationUrlKeyFromIssueUrl('file://linear.app:443/acme/issue/ENG-1')
    ).toBeNull()
  })
})
