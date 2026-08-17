// The cut-over address-bar classifier, in BOTH seam states.
//
// The whitespace cases are the point. The twin's `[^\s]+` is JS `\s`, the
// core's is Rust's, and they disagree about U+FEFF — JS counts it as
// whitespace, Rust does not. These inputs agree anyway, but by branch order
// rather than by the regexes matching, so they are pinned rather than trusted.
import { afterEach, describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import { looksLikeSearchQuery } from './browser-search-query-detection'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'

function bind(): void {
  setOrcaDispatchBinding((module, fn, input) => orcaDispatch(module, fn, input))
}

function inBothSeamStates(assert: () => void): void {
  setOrcaDispatchBinding(null)
  assert()
  bind()
  assert()
}

afterEach(bind)

const SEARCHES = ['react hooks', 'singleword', 'münchen', '日本語', 'foo bar', 'a😀b', '', ' ']
const NAVIGATIONS = [
  'example.com',
  'foo.bar/path',
  'localhost:3000',
  'a.io',
  'A.IO',
  'EXAMPLE.COM/Path',
  'http://x.com',
  'a:b',
  '😀.com'
]
// JS-vs-Rust whitespace disagreement (U+FEFF), plus other space classes.
// Computed from the twin body, not guessed — the first draft of this list had
// five of the seven backwards and the cases caught it, which is the only
// evidence that they discriminate at all. Note the asymmetry U+FEFF produces:
// leading/trailing it blocks the URL pattern (so the input reads as a URL via
// the dot branch), but in the MIDDLE of a dotless word it changes nothing.
const WHITESPACE = [
  ['foo﻿bar', true],
  ['﻿example.com', false],
  ['example.com﻿', false],
  ['foo bar', true],
  ['foo　bar', true],
  ['tab\tsep', true],
  ['new\nline', true]
] as const

describe('looksLikeSearchQuery', () => {
  for (const input of SEARCHES) {
    it(`treats ${JSON.stringify(input)} as a search in both seam states`, () => {
      inBothSeamStates(() => expect(looksLikeSearchQuery(input)).toBe(true))
    })
  }
  for (const input of NAVIGATIONS) {
    it(`treats ${JSON.stringify(input)} as a navigation in both seam states`, () => {
      inBothSeamStates(() => expect(looksLikeSearchQuery(input)).toBe(false))
    })
  }
  for (const [input, expected] of WHITESPACE) {
    it(`agrees on ${JSON.stringify(input)} despite the JS/Rust \\s split`, () => {
      inBothSeamStates(() => expect(looksLikeSearchQuery(input)).toBe(expected))
    })
  }
  it('answers the twin for input that cannot cross the seam', () => {
    inBothSeamStates(() => expect(looksLikeSearchQuery('lone\uD800surrogate')).toBe(true))
  })
})
