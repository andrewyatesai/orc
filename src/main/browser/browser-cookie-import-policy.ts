import type { Cookie, Cookies } from 'electron'
// Why: tldts ships the effective-TLD list this fork already vendors (upstream uses `psl`); it
// resolves the registrable boundary that bounds domain-scope cookie replacement.
import { parse as parseDomain } from 'tldts'

// Why: match psl's default of consulting the PRIVATE section too, so github.io/*.blogspot.com
// are treated as public suffixes and never over-cleared as if they owned their subdomains.
const PSL_OPTIONS = { allowPrivateDomains: true } as const

const GOOGLE_SOURCE_BOUND_COOKIE_NAMES = new Set([
  'SIDCC',
  '__Secure-1PSIDCC',
  '__Secure-3PSIDCC',
  '__Secure-STRP',
  'AEC'
])

export type CookieImportMode = 'merge' | 'replace-imported-domains'

export function normalizeCookieDomain(domain: string): string | null {
  const candidate = domain.trim().replace(/^\.+/, '')
  const isBracketedIpv6 = candidate.startsWith('[') && candidate.endsWith(']')
  if (!candidate || /[/\\@?#%]/.test(candidate) || (!isBracketedIpv6 && candidate.includes(':'))) {
    return null
  }
  try {
    const parsed = new URL(`https://${candidate}/`)
    const normalized = parsed.hostname.toLowerCase()
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      normalized.endsWith('.') ||
      normalized.includes('..')
    ) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

export function normalizeCookieImportDomain(domain: string): string | null {
  const normalized = normalizeCookieDomain(domain)
  if (!normalized) {
    return null
  }
  // Why: bracketed IPv6 literals are a valid cookie scope but have no registrable owner; accept as-is.
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return normalized
  }
  const parsed = parseDomain(normalized, PSL_OPTIONS)
  // Why: a bare public suffix (com, co.uk, github.io) has no registrable owner, so it can never be a
  // safe import scope — clearing it would wipe every site under that suffix.
  if (parsed.domain === null && (parsed.isIcann === true || parsed.isPrivate === true)) {
    return null
  }
  return normalized
}

export function isGoogleSourceBoundCookie(name: string, domain: string): boolean {
  if (!GOOGLE_SOURCE_BOUND_COOKIE_NAMES.has(name)) {
    return false
  }
  const normalized = normalizeCookieDomain(domain)
  return normalized === 'google.com' || normalized?.endsWith('.google.com') === true
}

function domainSuffixes(domain: string): string[] {
  const labels = domain.split('.')
  return labels.map((_, index) => labels.slice(index).join('.'))
}

function importDomainAncestors(domain: string): string[] {
  const parsed = parseDomain(domain, PSL_OPTIONS)
  const boundary = parsed.domain ?? domain
  const ancestors: string[] = []
  for (const suffix of domainSuffixes(domain)) {
    ancestors.push(suffix)
    if (suffix === boundary) {
      break
    }
  }
  return ancestors
}

function importedDomainScopes(domains: readonly string[]): {
  exact: Set<string>
  ancestors: Set<string>
  descendantRoots: Set<string>
} {
  const exact = new Set<string>()
  const ancestors = new Set<string>()
  const descendantRoots = new Set<string>()
  const seen = new Set<string>()
  for (const domain of domains) {
    const candidate = normalizeCookieDomain(domain)
    if (!candidate || seen.has(candidate)) {
      continue
    }
    seen.add(candidate)
    const normalized = normalizeCookieImportDomain(candidate)
    if (!normalized || exact.has(normalized)) {
      continue
    }
    exact.add(normalized)
    if (normalized.includes('.')) {
      descendantRoots.add(normalized)
    }
    for (const suffix of importDomainAncestors(normalized)) {
      ancestors.add(suffix)
    }
  }
  return { exact, ancestors, descendantRoots }
}

function overlapsImportedDomain(
  cookie: Cookie,
  domain: string,
  scopes: ReturnType<typeof importedDomainScopes>
): boolean {
  if (scopes.exact.has(domain)) {
    return true
  }
  // Why: a non-host-only parent cookie (.google.com) is delivered to the imported child, so it must
  // go too; a host-only parent stays put — it never reaches the child.
  if (cookie.hostOnly !== true && scopes.ancestors.has(domain)) {
    return true
  }
  return domainSuffixes(domain).some((suffix) => scopes.descendantRoots.has(suffix))
}

function cookieRemovalUrl(cookie: Cookie, domain: string): string | null {
  try {
    const url = new URL(`${cookie.secure ? 'https' : 'http'}://${domain}/`)
    url.pathname = cookie.path?.startsWith('/') ? cookie.path : '/'
    return url.toString()
  } catch {
    return null
  }
}

export async function restoreImportedDomainCookies(
  store: Pick<Cookies, 'set'>,
  cookies: readonly Cookie[]
): Promise<void> {
  const failures: unknown[] = []
  for (const cookie of cookies) {
    try {
      const domain = cookie.domain ? normalizeCookieDomain(cookie.domain) : null
      const url = domain ? cookieRemovalUrl(cookie, domain) : null
      if (!url) {
        continue
      }
      await store.set({
        url,
        name: cookie.name,
        value: cookie.value,
        ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
        ...(cookie.path ? { path: cookie.path } : {}),
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        ...(cookie.expirationDate ? { expirationDate: cookie.expirationDate } : {})
      })
    } catch (err) {
      failures.push(err)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Could not restore replaced cookies')
  }
}

export async function replaceCookiesForImportedDomains(
  store: Pick<Cookies, 'get' | 'remove' | 'set'>,
  importedDomains: readonly string[]
): Promise<Cookie[]> {
  const scopes = importedDomainScopes(importedDomains)
  if (scopes.exact.size === 0) {
    return []
  }

  const existingCookies = await store.get({})
  const removedCookies: Cookie[] = []
  for (const cookie of existingCookies) {
    const domain = cookie.domain ? normalizeCookieDomain(cookie.domain) : null
    if (!domain || !overlapsImportedDomain(cookie, domain, scopes)) {
      continue
    }
    const url = cookieRemovalUrl(cookie, domain)
    if (!url) {
      continue
    }
    try {
      await store.remove(url, cookie.name)
      removedCookies.push(cookie)
    } catch (err) {
      try {
        await restoreImportedDomainCookies(store, removedCookies)
      } catch (restoreError) {
        throw new AggregateError([err, restoreError], 'Cookie replacement and rollback failed')
      }
      throw err
    }
  }
  return removedCookies
}
