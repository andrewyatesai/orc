/**
 * How the dispatch boundary says no: the rejection error, the field path it names,
 * and the plain-English reason for every value JSON would have mangled.
 *
 * Split out of `dispatch-payload-codec.ts` (its only production consumer) because
 * the explanations are the bulk of the text and none of the hot path — the walk
 * calls into here only when it is already throwing. Import
 * `DispatchPayloadError` from the codec; it re-exports this one.
 */

/** Steps from the root to the offending value; rendered into a path only on rejection. */
export type PathTrail = (string | number)[]

const IDENTIFIER_KEY = /^[A-Za-z_$][\w$]*$/

/** Where the boundary said no, and why. `path` is the offending field. */
export class DispatchPayloadError extends Error {
  readonly path: string
  readonly reason: string

  constructor(path: string, reason: string) {
    super(`dispatch payload rejected at \`${path}\`: ${reason}`)
    this.name = 'DispatchPayloadError'
    this.path = path
    this.reason = reason
  }
}

export function childPath(path: string, key: string): string {
  return IDENTIFIER_KEY.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}

export function renderPath(trail: PathTrail): string {
  let path = String(trail[0])
  for (let step = 1; step < trail.length; step++) {
    const key = trail[step]
    path = typeof key === 'number' ? `${path}[${key}]` : childPath(path, key)
  }
  return path
}

export function reject(trail: PathTrail, reason: string): never {
  throw new DispatchPayloadError(renderPath(trail), reason)
}

/** Diagnose which of the three JSON-impossible numbers this is. */
export function rejectNumber(value: number, trail: PathTrail): never {
  if (Number.isNaN(value)) {
    reject(
      trail,
      'is NaN, which JSON.stringify writes as null — send a sentinel the Rust module understands instead'
    )
  }
  if (!Number.isFinite(value)) {
    reject(
      trail,
      `is ${value > 0 ? 'Infinity' : '-Infinity'}, which JSON.stringify writes as null — send a sentinel or clamp before dispatching`
    )
  }
  reject(
    trail,
    'is -0, which JSON has no representation for (it would arrive as 0) — write 0 if that is what you mean'
  )
}

/** `keys` is `Object.keys(value)`, already known to disagree with `value.length`. */
export function describeArrayDefect(value: unknown[], keys: string[]): string {
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) {
      return `is a sparse array: index ${index} is a hole, which JSON.stringify writes as null — fill it or filter the array`
    }
  }
  const extra = keys.filter((key) => !Number.isInteger(Number(key)))
  return `is an array carrying non-index own properties (${extra.join(', ')}), which JSON.stringify silently drops — send an object if those fields matter`
}

/** Name what a non-plain object would have turned into, not just that it is wrong. */
export function describeExotic(value: object): string {
  // Cross-realm safe (the renderer/preload split makes `instanceof` unreliable).
  const tag = Object.prototype.toString.call(value).slice(8, -1)
  switch (tag) {
    case 'Date':
      return 'is a Date, which JSON.stringify silently substitutes with its ISO string — pass date.toISOString() or date.getTime() so the Rust side gets the type it expects'
    case 'Map':
      return 'is a Map, which JSON.stringify emits as {} — every entry would vanish; pass Object.fromEntries(map) or an array of pairs'
    case 'Set':
      return 'is a Set, which JSON.stringify emits as {} — every member would vanish; pass [...set]'
    case 'RegExp':
      return 'is a RegExp, which JSON.stringify emits as {} — pass its source string'
    case 'Error':
      return 'is an Error, whose message and stack are not own enumerable properties and would vanish — pass the fields you need'
    default: {
      // A class instance tags as plain "Object"; its constructor is the name the
      // author will recognise in the trace.
      const name = tag === 'Object' ? (value.constructor?.name ?? 'anonymous class') : tag
      return `is a ${name} instance, not a plain object — only plain objects and arrays cross the boundary, so pass an object literal with the fields the Rust module reads`
    }
  }
}

export function describeType(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'object') {
    return `a ${Object.prototype.toString.call(value).slice(8, -1)}`
  }
  return `a ${typeof value}`
}
