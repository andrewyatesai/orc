import { describe, expect, it } from 'vitest'
import {
  formatRouteAccountScope,
  formatRouteKey,
  parseRouteKey,
  routeKeysEqual,
  type RouteKey
} from './route-key'

const localSystemDefault: RouteKey = {
  provider: 'claude',
  account: { kind: 'system-default' },
  host: { kind: 'local' }
}

describe('formatRouteKey / parseRouteKey', () => {
  it('round-trips system-default — the route an accountId-keyed map cannot name', () => {
    const formatted = formatRouteKey(localSystemDefault)
    expect(formatted).toBe('claude/system-default@local')
    expect(parseRouteKey(formatted)).toEqual(localSystemDefault)
  })

  it.each([
    [
      'managed account on a named wsl distro',
      {
        provider: 'codex',
        account: { kind: 'managed', accountId: 'acct_1' },
        host: { kind: 'wsl', distro: 'Ubuntu' }
      } as RouteKey
    ],
    [
      'wsl default distro',
      {
        provider: 'codex',
        account: { kind: 'system-default' },
        host: { kind: 'wsl', distro: null }
      } as RouteKey
    ],
    [
      'ssh host',
      {
        provider: 'gemini',
        account: { kind: 'managed', accountId: 'a/b@c' },
        host: { kind: 'ssh', targetId: 'box:22' }
      } as RouteKey
    ],
    [
      'remote runtime',
      {
        provider: 'claude',
        account: { kind: 'system-default' },
        host: { kind: 'runtime', environmentId: 'env 1' }
      } as RouteKey
    ]
  ])('round-trips %s', (_label, key) => {
    expect(parseRouteKey(formatRouteKey(key))).toEqual(key)
  })

  it('keeps separators unambiguous when the parts contain them', () => {
    const key: RouteKey = {
      provider: 'claude',
      account: { kind: 'managed', accountId: 'has/slash@and:colon' },
      host: { kind: 'ssh', targetId: 'also/@:' }
    }
    expect(parseRouteKey(formatRouteKey(key))).toEqual(key)
  })

  it('normalizes a blank wsl distro to the default rather than an empty name', () => {
    const key = parseRouteKey(
      formatRouteKey({
        provider: 'codex',
        account: { kind: 'system-default' },
        host: { kind: 'wsl', distro: '   ' }
      })
    )
    expect(key?.host).toEqual({ kind: 'wsl', distro: null })
  })

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['no account', 'claude@local'],
    ['unknown account tag', 'claude/borrowed@local'],
    ['empty managed id', 'claude/managed:@local'],
    ['unknown host', 'claude/system-default@moon:1'],
    ['empty host body', 'claude/system-default@ssh:'],
    ['no host', 'claude/system-default']
  ])('returns null for %s — never a coerced fallback', (_label, value) => {
    expect(parseRouteKey(value)).toBeNull()
  })
})

describe('routeKeysEqual', () => {
  it('separates two hosts spending the same subscription', () => {
    expect(
      routeKeysEqual(localSystemDefault, {
        ...localSystemDefault,
        host: { kind: 'wsl', distro: null }
      })
    ).toBe(false)
  })
})

describe('formatRouteAccountScope', () => {
  it('drops the host so one exhausted subscription is not healthy on another host', () => {
    const scope = formatRouteAccountScope(localSystemDefault)
    expect(scope).toBe(
      formatRouteAccountScope({ ...localSystemDefault, host: { kind: 'ssh', targetId: 'box' } })
    )
    expect(scope).not.toContain('local')
  })

  it('still separates two accounts of one provider', () => {
    expect(formatRouteAccountScope(localSystemDefault)).not.toBe(
      formatRouteAccountScope({
        ...localSystemDefault,
        account: { kind: 'managed', accountId: 'acct_1' }
      })
    )
  })
})

describe('canonical form', () => {
  it('rejects a non-canonical spelling that parses to the same route', () => {
    // Without the canonical check both of these parse to accountId "a@b", so a
    // unique index on target_route_key would hold two rows for one subscription
    // and a reservation could be claimed twice.
    expect(parseRouteKey('claude/managed:a@b@local')).toBeNull()
    expect(parseRouteKey('claude/managed:a%40b@local')).toEqual({
      provider: 'claude',
      account: { kind: 'managed', accountId: 'a@b' },
      host: { kind: 'local' }
    })
  })

  it('rejects a malformed percent escape instead of throwing at the caller', () => {
    // Route keys arrive from SQLite and CLI flags — untrusted input.
    for (const value of [
      '%/system-default@local',
      'claude/managed:%zz@local',
      'claude/system-default@ssh:%E0%A4%A'
    ]) {
      expect(parseRouteKey(value)).toBeNull()
    }
  })
})
