import { describe, expect, it } from 'vitest'
import {
  bindingsBlockingStore,
  commitPtyBinding,
  deserializePtyBinding,
  ptyBindingsEqual,
  serializePtyBinding
} from './pty-binding'
import type { RouteKey } from './route-key'
import { createStoreKey } from './store-key'

const route: RouteKey = {
  provider: 'claude',
  account: { kind: 'managed', accountId: 'acct_1' },
  host: { kind: 'local' }
}
const store = createStoreKey([{ kind: 'config-dir', path: '/home/u/.claude' }])

function bind(overrides: Partial<Parameters<typeof commitPtyBinding>[0]> = {}) {
  return commitPtyBinding({
    runtimeId: 'rt_1',
    ptyIncarnationId: 'inc_1',
    route,
    store,
    ...overrides
  })
}

describe('commitPtyBinding', () => {
  it('is frozen after commit, so a rotation cannot edit a live pane in place', () => {
    const binding = bind()
    expect(binding).not.toBeNull()
    expect(Object.isFrozen(binding)).toBe(true)
  })

  it.each([
    ['no runtime', { runtimeId: '' }],
    ['no incarnation', { ptyIncarnationId: '' }]
  ])('refuses to attribute a pane with %s', (_label, overrides) => {
    expect(bind(overrides)).toBeNull()
  })
})

describe('serialize / deserialize', () => {
  it('round-trips', () => {
    const binding = bind()!
    expect(deserializePtyBinding(serializePtyBinding(binding))).toEqual(binding)
  })

  it.each([
    ['null', null],
    ['a bad route', { runtimeId: 'rt_1', ptyIncarnationId: 'i', routeKey: 'nope', storeKey: '' }],
    [
      'a bad store',
      {
        runtimeId: 'rt_1',
        ptyIncarnationId: 'i',
        routeKey: 'claude/system-default@local',
        storeKey: 'wallet:/x'
      }
    ]
  ])('returns null for %s rather than a plausible binding', (_label, value) => {
    expect(deserializePtyBinding(value)).toBeNull()
  })
})

describe('ptyBindingsEqual', () => {
  it('separates two incarnations of one pane', () => {
    expect(ptyBindingsEqual(bind()!, bind({ ptyIncarnationId: 'inc_2' })!)).toBe(false)
  })
})

describe('bindingsBlockingStore', () => {
  const overlapping = bind()!
  const disjoint = bind({
    ptyIncarnationId: 'inc_2',
    store: createStoreKey([{ kind: 'config-dir', path: '/elsewhere' }])
  })!

  it('reports only live panes that touch the store', () => {
    const blocking = bindingsBlockingStore([overlapping, disjoint], store, () => true)
    expect(blocking).toEqual([overlapping])
  })

  it('an ended incarnation does not block a drain', () => {
    expect(bindingsBlockingStore([overlapping], store, () => false)).toEqual([])
  })
})

describe('immutability after commit', () => {
  it('a caller mutating the route it passed cannot rewrite the committed binding', () => {
    // Object.freeze is shallow; retaining the caller's route object would make
    // "what was this pane spending" rewritable after the fact.
    const mutableRoute: RouteKey = {
      provider: 'claude',
      account: { kind: 'managed', accountId: 'acct_1' },
      host: { kind: 'local' }
    }
    const binding = commitPtyBinding({
      runtimeId: 'rt_1',
      ptyIncarnationId: 'inc_1',
      route: mutableRoute,
      store
    })!
    const before = serializePtyBinding(binding).routeKey

    mutableRoute.account = { kind: 'managed', accountId: 'victim_account' }
    ;(mutableRoute.account as { accountId: string }).accountId = 'victim_account'
    mutableRoute.host = { kind: 'ssh', targetId: 'other-box' }

    expect(serializePtyBinding(binding).routeKey).toBe(before)
    expect(before).toContain('acct_1')
  })

  it('a caller mutating the store surfaces cannot rewrite the binding', () => {
    const surface = { kind: 'config-dir' as const, path: '/home/u/.claude' }
    const mutableStore = createStoreKey([surface])
    const binding = commitPtyBinding({
      runtimeId: 'rt_1',
      ptyIncarnationId: 'inc_1',
      route,
      store: mutableStore
    })!
    const before = serializePtyBinding(binding).storeKey
    surface.path = '/etc/shadow'
    expect(serializePtyBinding(binding).storeKey).toBe(before)
  })
})
