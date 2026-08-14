import { describe, expect, it } from 'vitest'
import { clampUtf8TextPrefix, measureUtf8ByteLength, readUtf8CodePointAt } from './utf8-byte-limits'

describe('readUtf8CodePointAt', () => {
  it('reads an ASCII code unit', () => {
    expect(readUtf8CodePointAt('r', 0)).toBe(0x72)
  })

  it('pairs a well-formed surrogate pair into its astral code point', () => {
    expect(readUtf8CodePointAt('😀', 0)).toBe(0x1f600)
  })

  it('returns a lone high surrogate at the end of the string, never pairing past the end', () => {
    expect(readUtf8CodePointAt('\ud83d', 0)).toBe(0xd83d)
  })

  it('returns a high surrogate not followed by a low surrogate as itself', () => {
    expect(readUtf8CodePointAt('\ud83dx', 0)).toBe(0xd83d)
  })

  it('returns a lone low surrogate as itself', () => {
    expect(readUtf8CodePointAt('\ude00', 0)).toBe(0xde00)
  })
})

// Once V8 optimizes the calling function, `String.prototype.codePointAt` on a sliced string
// pairs a trailing high surrogate with the code unit that follows the SLICE inside its parent
// (reproduced on Node 24 and 26). A prefix slice cut mid-pair then reads a code point the
// string does not contain, so a scan reports one byte too many — but only after tier-up, which
// is why it surfaced as an intermittent CI failure rather than a deterministic one.
// Build a rope, cut it mid-pair, and hammer the scan so the optimizing tier is under test.
const SLICE_BOUNDARY_PARENT_UNITS = [
  0x72, 0x2e6, 0x7b, 0x54, 0xda9b, 0x568, 0x52, 0x26, 0x46, 0xc15b, 0x7, 0x768, 0xd9f6, 0xdcde
]
// V8 only creates a sliced string (rather than copying) at 13 code units or more.
const SLICE_BOUNDARY_UNITS = 13
const TIER_UP_ITERATIONS = 200_000

function buildSliceEndingInLoneHighSurrogate(): string {
  let text = ''
  for (const unit of SLICE_BOUNDARY_PARENT_UNITS) {
    text += String.fromCharCode(unit)
  }
  return text.slice(0, SLICE_BOUNDARY_UNITS)
}

describe('scanning a prefix slice whose parent continues past the slice', () => {
  const sliced = buildSliceEndingInLoneHighSurrogate()

  it('is a sliced string that ends in a lone high surrogate', () => {
    expect(sliced.length).toBe(SLICE_BOUNDARY_UNITS)
    expect(sliced.charCodeAt(SLICE_BOUNDARY_UNITS - 1)).toBe(0xd9f6)
    expect(Buffer.byteLength(sliced, 'utf8')).toBe(22)
  })

  it('reads the trailing lone surrogate without pairing past the end in every JIT tier', () => {
    const observed = new Set<number>()
    for (let iteration = 0; iteration < TIER_UP_ITERATIONS; iteration += 1) {
      observed.add(readUtf8CodePointAt(sliced, SLICE_BOUNDARY_UNITS - 1))
    }
    expect([...observed]).toEqual([0xd9f6])
  })

  it('measures the same byte length as the encoder in every JIT tier', () => {
    const expected = Buffer.byteLength(sliced, 'utf8')
    const observed = new Set<number>()
    for (let iteration = 0; iteration < TIER_UP_ITERATIONS; iteration += 1) {
      observed.add(measureUtf8ByteLength(sliced).byteLength)
    }
    expect([...observed]).toEqual([expected])
  })

  it('does not report an exceeded limit at the true byte length in every JIT tier', () => {
    const limit = Buffer.byteLength(sliced, 'utf8')
    const observed = new Set<boolean>()
    for (let iteration = 0; iteration < TIER_UP_ITERATIONS; iteration += 1) {
      observed.add(measureUtf8ByteLength(sliced, { stopAfterBytes: limit }).exceededLimit)
    }
    expect([...observed]).toEqual([false])
  })

  it('keeps the whole slice when clamping to its true byte length in every JIT tier', () => {
    const limit = Buffer.byteLength(sliced, 'utf8')
    const observed = new Set<number>()
    for (let iteration = 0; iteration < TIER_UP_ITERATIONS; iteration += 1) {
      observed.add(clampUtf8TextPrefix(sliced, limit).length)
    }
    expect([...observed]).toEqual([SLICE_BOUNDARY_UNITS])
  })
})
