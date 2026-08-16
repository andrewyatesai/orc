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

  // Pins the refusal recorded on the function: `new URL` re-encodes the pathname
  // and IDNA-maps the host, and `orca_core::linear_links::parse_absolute_url`
  // does neither — so wiring this to the core turns these red instead of
  // silently changing a persisted `linkedLinearIssueOrganizationUrlKey`.
  it('keeps the WHATWG-normalized answer the Rust parse does not reproduce', () => {
    expect(getLinearOrganizationUrlKeyFromIssueUrl('https://linear.app/acme inc/issue/ENG-1')).toBe(
      'acme%20inc'
    )
    expect(getLinearOrganizationUrlKeyFromIssueUrl('https://linear%2eapp/acme/issue/ENG-1')).toBe(
      'acme'
    )
    expect(getLinearOrganizationUrlKeyFromIssueUrl('foo://LINEAR.APP/evil/issue/ENG-1')).toBeNull()
  })
})
