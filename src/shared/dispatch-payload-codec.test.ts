import { describe, expect, it } from 'vitest'
import {
  DISPATCH_ERROR_KEY,
  MODULE_ERROR_KEY,
  DispatchCoreError,
  DispatchPayloadError,
  decodeDispatchResult,
  encodeDispatchPayload,
  encodeNumericDispatchPayload
} from './dispatch-payload-codec'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

const LONE_LEADING = '\ud800'
const LONE_TRAILING = '\udc00'
const ROCKET = '\u{1f680}' // a matched surrogate pair — the control that must survive

function rejection(run: () => unknown): DispatchPayloadError {
  try {
    run()
  } catch (error) {
    if (error instanceof DispatchPayloadError) {
      return error
    }
    throw error
  }
  throw new Error('expected the encoder to reject this payload')
}

describe('encodeDispatchPayload — surrogates', () => {
  it('round-trips a matched pair (astral character) unchanged', () => {
    const text = encodeDispatchPayload({ title: `${ROCKET} ship it` })
    expect(JSON.parse(text)).toEqual({ title: `${ROCKET} ship it` })
    // Emitted raw, not \u-escaped: the bytes are valid UTF-8 for serde.
    expect(text).toContain(ROCKET)
  })

  it('rejects a lone leading surrogate and names the field and code unit', () => {
    const error = rejection(() =>
      encodeDispatchPayload({ filesModified: ['src/a.ts', `src/b${LONE_LEADING}.ts`] })
    )
    expect(error.path).toBe('input.filesModified[1]')
    expect(error.message).toContain('unpaired UTF-16 surrogate (0xd800)')
    expect(error.message).toContain('code-unit 5')
  })

  it('rejects a lone trailing surrogate', () => {
    expect(rejection(() => encodeDispatchPayload(`x${LONE_TRAILING}`)).path).toBe('input')
  })

  it('rejects a surrogate in an object KEY', () => {
    const error = rejection(() => encodeDispatchPayload({ [`k${LONE_LEADING}`]: 1 }))
    expect(error.message).toContain('unpaired UTF-16 surrogate')
  })

  it('rejects a pair broken across concatenation but accepts the halves rejoined', () => {
    const high = ROCKET.charAt(0)
    const low = ROCKET.charAt(1)
    expect(() => encodeDispatchPayload({ a: high, b: low })).toThrow(DispatchPayloadError)
    expect(JSON.parse(encodeDispatchPayload({ a: high + low }))).toEqual({ a: ROCKET })
  })

  it('does not false-positive on data that literally contains the text \\ud800', () => {
    // The cheap output regex matches this; the precise value scan clears it.
    const payload = { note: String.raw`escaped as \ud800 in the log` }
    expect(JSON.parse(encodeDispatchPayload(payload))).toEqual(payload)
  })
})

describe('encodeDispatchPayload — undefined', () => {
  it('encodes a top-level undefined as the no-arg null', () => {
    expect(encodeDispatchPayload(undefined)).toBe('null')
    expect(encodeDispatchPayload(null)).toBe('null')
  })

  it('rejects an explicitly-undefined property rather than dropping the key', () => {
    const error = rejection(() => encodeDispatchPayload({ branch: 'main', base: undefined }))
    expect(error.path).toBe('input.base')
    expect(error.message).toContain('DROPS the key')
  })

  it('omits undefined properties only on explicit opt-in', () => {
    const text = encodeDispatchPayload(
      { branch: 'main', base: undefined },
      { undefinedProperties: 'omit' }
    )
    expect(JSON.parse(text)).toEqual({ branch: 'main' })
  })

  it('rejects undefined inside an array even when properties may be omitted', () => {
    const error = rejection(() =>
      encodeDispatchPayload({ list: ['a', undefined] }, { undefinedProperties: 'omit' })
    )
    expect(error.path).toBe('input.list[1]')
  })
})

describe('encodeDispatchPayload — numbers', () => {
  it('rejects NaN, Infinity and -Infinity by path instead of sending null', () => {
    expect(rejection(() => encodeDispatchPayload({ ratio: Number.NaN })).message).toContain(
      'is NaN'
    )
    expect(rejection(() => encodeDispatchPayload({ cap: Infinity })).message).toContain(
      'is Infinity'
    )
    expect(rejection(() => encodeDispatchPayload([-Infinity])).message).toContain('is -Infinity')
  })

  it('rejects -0, which JSON cannot represent, and accepts 0', () => {
    expect(rejection(() => encodeDispatchPayload({ drift: -0 })).path).toBe('input.drift')
    expect(encodeDispatchPayload({ drift: 0 })).toBe('{"drift":0}')
  })

  it('keeps ordinary finite numbers byte-identical to JSON.stringify', () => {
    const payload = { a: 1, b: -2.5, c: 1e21, d: Number.MAX_SAFE_INTEGER }
    expect(encodeDispatchPayload(payload)).toBe(JSON.stringify(payload))
  })
})

describe('encodeDispatchPayload — values JSON silently mangles', () => {
  it('rejects bigint, symbol values, symbol keys and functions', () => {
    expect(rejection(() => encodeDispatchPayload({ id: 1n })).message).toContain('is a bigint')
    expect(rejection(() => encodeDispatchPayload({ tag: Symbol('x') })).message).toContain(
      'is a symbol'
    )
    expect(rejection(() => encodeDispatchPayload({ [Symbol('k')]: 1 })).message).toContain(
      'symbol-keyed'
    )
    expect(rejection(() => encodeDispatchPayload({ run: () => 1 })).message).toContain(
      'is a function'
    )
  })

  it('rejects Date, Map, Set, RegExp and class instances by naming what would be lost', () => {
    expect(rejection(() => encodeDispatchPayload({ at: new Date(0) })).message).toContain(
      'is a Date'
    )
    expect(rejection(() => encodeDispatchPayload({ m: new Map([['a', 1]]) })).message).toContain(
      'is a Map'
    )
    expect(rejection(() => encodeDispatchPayload({ s: new Set([1]) })).message).toContain(
      'is a Set'
    )
    expect(rejection(() => encodeDispatchPayload({ r: /x/ })).message).toContain('is a RegExp')
    class Worktree {
      readonly id = 'w1'
    }
    expect(rejection(() => encodeDispatchPayload({ w: new Worktree() })).message).toContain(
      'is a Worktree instance'
    )
  })

  it('rejects a plain object that defines toJSON', () => {
    const payload = { at: { toJSON: () => 'rewritten', real: 1 } }
    expect(rejection(() => encodeDispatchPayload(payload)).message).toContain('defines toJSON')
  })

  it('accepts a null-prototype object (it is still a plain bag of data)', () => {
    const bag = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 })
    expect(encodeDispatchPayload(bag)).toBe('{"a":1}')
  })
})

describe('encodeDispatchPayload — arrays and cycles', () => {
  it('rejects a sparse array by naming the hole index', () => {
    const sparse = ['a', , 'c'] as unknown[] // eslint-disable-line no-sparse-arrays
    expect(rejection(() => encodeDispatchPayload({ list: sparse })).message).toContain(
      'index 1 is a hole'
    )
  })

  it('rejects non-index own properties on an array', () => {
    const list = ['a'] as string[] & { total?: number }
    list.total = 1
    expect(rejection(() => encodeDispatchPayload({ list })).message).toContain(
      'non-index own properties'
    )
  })

  it('rejects a cyclic reference at the depth cap with a path', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node
    const error = rejection(() => encodeDispatchPayload(node))
    expect(error.message).toContain('cyclic reference')
    expect(error.path.startsWith('input.self.self')).toBe(true)
  })

  it('accepts deeply but finitely nested payloads', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 100; i++) {
      deep = { deep }
    }
    expect(() => encodeDispatchPayload(deep)).not.toThrow()
  })
})

describe('encodeNumericDispatchPayload — the fast path', () => {
  it('matches JSON.stringify for a flat numeric record and a bare number', () => {
    expect(encodeNumericDispatchPayload({ droppableSessions: 7 })).toBe('{"droppableSessions":7}')
    expect(encodeNumericDispatchPayload(12)).toBe('12')
  })

  it('applies the same number rules', () => {
    expect(rejection(() => encodeNumericDispatchPayload({ n: Number.NaN })).path).toBe('input.n')
    expect(rejection(() => encodeNumericDispatchPayload({ n: -0 })).message).toContain('is -0')
  })

  it('refuses non-numeric values instead of silently taking the slow hazards', () => {
    const payload = { n: 'not a number' } as unknown as Record<string, number>
    expect(rejection(() => encodeNumericDispatchPayload(payload)).message).toContain(
      'use encodeDispatchPayload'
    )
  })
})

describe('decodeDispatchResult', () => {
  it('returns ordinary results, including null and false', () => {
    expect(decodeDispatchResult('{"ok":true}')).toEqual({ ok: true })
    expect(decodeDispatchResult('null')).toBeNull()
    expect(decodeDispatchResult('false')).toBe(false)
  })

  it('throws on the core error envelope instead of returning it as a result', () => {
    const text = JSON.stringify({ [DISPATCH_ERROR_KEY]: 'unknown module task-claim' })
    let thrown: unknown
    try {
      decodeDispatchResult(text, { module: 'task-claim', fn: 'compare' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DispatchCoreError)
    expect((thrown as DispatchCoreError).kind).toBe('core-error')
    expect((thrown as Error).message).toContain('task-claim.compare failed in the Rust core')
    expect((thrown as Error).message).toContain('unknown module task-claim')
  })

  it('throws on a module’s unknown-function envelope too', () => {
    const text = JSON.stringify({ [MODULE_ERROR_KEY]: 'unknown function tokenzie' })
    expect(() => decodeDispatchResult(text)).toThrow(/unknown function tokenzie/)
  })

  it('throws when the core answers something that is not JSON', () => {
    expect(() => decodeDispatchResult('<not json>')).toThrow(DispatchCoreError)
  })
})

// Text-level end-to-end: the encoder's OUTPUT string is what the Rust core must
// accept, so this reaches the wasm core directly (the global vitest setup already
// initSync'd this exact module) rather than through the seam, whose own
// JSON.stringify would hide the bytes under test.
describe('against the real Rust core (wasm)', () => {
  const call = { module: 'task-query', fn: 'tokenizeSearchQuery' }
  const tokenize = (input: unknown): unknown =>
    decodeDispatchResult(orcaDispatch(call.module, call.fn, encodeDispatchPayload(input)), call)

  it('round-trips an astral character through the core unchanged', () => {
    expect(tokenize(`${ROCKET} is:open`)).toEqual([ROCKET, 'is:open'])
  })

  it('never reaches the core with a lone surrogate — the encoder stops it first', () => {
    expect(() => tokenize(`${LONE_LEADING} is:open`)).toThrow(DispatchPayloadError)
  })

  it('turns an unknown module into a thrown DispatchCoreError', () => {
    expect(() =>
      decodeDispatchResult(orcaDispatch('no-such-module', 'nope', 'null'), {
        module: 'no-such-module',
        fn: 'nope'
      })
    ).toThrow(DispatchCoreError)
  })

  it('turns a real module’s unknown function into a thrown DispatchCoreError', () => {
    expect(() =>
      decodeDispatchResult(orcaDispatch(call.module, 'tokenzieSearchQuery', '"is:open"'), call)
    ).toThrow(DispatchCoreError)
  })
})

// Why these are here and not in the full-encoder block: the fast path skips the recursive walk, so
// it needs its own proof that it refuses the same shapes. Object.keys(new Date()) is [], which let
// every exotic object with no own enumerable keys through the key loop untouched.
describe('the all-numeric fast path refuses what the full encoder refuses', () => {
  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map([['a', 1]])],
    ['a Set', new Set([1])],
    ['a RegExp', /x/],
    [
      'a class instance',
      new (class Counter {
        n = 1
      })()
    ]
  ])('rejects %s instead of stringifying it', (_label, value) => {
    expect(() => encodeNumericDispatchPayload(value as never)).toThrow(DispatchPayloadError)
  })

  it('still accepts a plain flat record of numbers', () => {
    expect(encodeNumericDispatchPayload({ droppableSessions: 40 })).toBe('{"droppableSessions":40}')
  })

  it('still accepts a null-prototype record', () => {
    const bare = Object.assign(Object.create(null), { n: 1 }) as Record<string, number>
    expect(encodeNumericDispatchPayload(bare)).toBe('{"n":1}')
  })
})
