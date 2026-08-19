#!/usr/bin/env node

// Generates rust/crates/orca-core/src/unicode_nfc_data.rs — the canonical
// decomposition / combining-class / primary-composite tables that let the
// zero-dependency core answer `String.prototype.normalize('NFC')`.
//
// WHY GENERATE FROM NODE: the twin — now the cut-over shim's `parity` fallback,
// `src/shared/cross-platform-path-resolution.ts` — folds paths with V8's
// `normalize('NFC')`, so V8's ICU tables ARE the specification.
// Deriving them from this runtime rather than transcribing a checked-in UCD copy
// removes the step that can silently disagree, and pins the Unicode version in
// the generated header.
//
// The three tables, and why NFC (UAX #15) needs each:
//   DECOMPOSITIONS   full canonical decomposition, already canonically ordered —
//                    read straight off `normalize('NFD')`. Hangul syllables are
//                    excluded: they decompose algorithmically, and would
//                    otherwise add 11172 rows.
//   COMBINING_CLASSES ccc, needed for canonical ordering AND for the composition
//                    blocking rule. Only characters WITHOUT a decomposition can
//                    survive the decomposition pass, so only those need a class.
//                    Measured by probing ICU's own reordering, never assumed.
//   COMPOSITIONS     primary composites `(a, b) -> c`. These are the PAIRWISE
//                    UCD mappings, which full NFD does not give: NFD(U+1EA6) is
//                    three characters while its primary pair is (U+00C2, U+0300).
//                    The pair is recovered by recomposing the NFD prefix, then
//                    confirmed with ICU — which is exactly the
//                    Full_Composition_Exclusion test without needing the file.

import fs from 'node:fs'
import path from 'node:path'

const OUT = path.resolve(import.meta.dirname, '../../rust/crates/orca-core/src/unicode_nfc_data.rs')

const HANGUL_S_BASE = 0xac00
const HANGUL_S_COUNT = 11172

const cp = (n) => String.fromCodePoint(n)
const chars = (s) => [...s].map((c) => c.codePointAt(0))
const isSurrogate = (n) => n >= 0xd800 && n <= 0xdfff
const isHangulSyllable = (n) => n >= HANGUL_S_BASE && n < HANGUL_S_BASE + HANGUL_S_COUNT

/** Every non-zero canonical combining class Unicode assigns. Used only as the
 *  pool of LABELS for classes ICU's reordering has already separated. */
const CCC_LADDER = [
  1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 84, 91, 103, 107, 118, 122, 129, 130, 132, 133, 202, 214, 216, 218, 220,
  222, 224, 226, 228, 230, 232, 233, 234, 240
]

/** One character per class, so the measured classes can be NAMED with their UCD
 *  numbers. A wrong entry cannot change NFC output — the algorithm only ever
 *  compares classes — and is caught by the ordering assertion below. */
const CLASS_PROBES = new Map([
  [0x0334, 1], // COMBINING TILDE OVERLAY
  [0x16ff0, 6], // VIETNAMESE ALTERNATE READING MARK CA
  [0x093c, 7], // DEVANAGARI SIGN NUKTA
  [0x3099, 8], // COMBINING KATAKANA-HIRAGANA VOICED SOUND MARK
  [0x094d, 9], // DEVANAGARI SIGN VIRAMA
  [0x05b0, 10], // HEBREW POINT SHEVA
  [0x05b1, 11], // HEBREW POINT HATAF SEGOL
  [0x05b2, 12], // HEBREW POINT HATAF PATAH
  [0x05b3, 13], // HEBREW POINT HATAF QAMATS
  [0x05b4, 14], // HEBREW POINT HIRIQ
  [0x05b5, 15], // HEBREW POINT TSERE
  [0x05b6, 16], // HEBREW POINT SEGOL
  [0x05b7, 17], // HEBREW POINT PATAH
  [0x05b8, 18], // HEBREW POINT QAMATS
  [0x05b9, 19], // HEBREW POINT HOLAM
  [0x05bb, 20], // HEBREW POINT QUBUTS
  [0x05bc, 21], // HEBREW POINT DAGESH OR MAPIQ
  [0x05bd, 22], // HEBREW POINT METEG
  [0x05bf, 23], // HEBREW POINT RAFE
  [0x05c1, 24], // HEBREW POINT SHIN DOT
  [0x05c2, 25], // HEBREW POINT SIN DOT
  [0xfb1e, 26], // HEBREW POINT JUDEO-SPANISH VARIKA
  [0x064b, 27], // ARABIC FATHATAN
  [0x064c, 28], // ARABIC DAMMATAN
  [0x064d, 29], // ARABIC KASRATAN
  [0x0618, 30], // ARABIC SMALL FATHA
  [0x0619, 31], // ARABIC SMALL DAMMA
  [0x061a, 32], // ARABIC SMALL KASRA
  [0x0651, 33], // ARABIC SHADDA
  [0x0652, 34], // ARABIC SUKUN
  [0x0670, 35], // ARABIC LETTER SUPERSCRIPT ALEF
  [0x0711, 36], // SYRIAC LETTER SUPERSCRIPT ALAPH
  [0x0c55, 84], // TELUGU LENGTH MARK
  [0x0c56, 91], // TELUGU AI LENGTH MARK
  [0x0e38, 103], // THAI CHARACTER SARA U
  [0x0e48, 107], // THAI CHARACTER MAI EK
  [0x0eb8, 118], // LAO VOWEL SIGN U
  [0x0ec8, 122], // LAO TONE MAI EK
  [0x0f71, 129], // TIBETAN VOWEL SIGN AA
  [0x0f72, 130], // TIBETAN VOWEL SIGN I
  [0x0f74, 132], // TIBETAN VOWEL SIGN U
  [0x0321, 202], // COMBINING PALATALIZED HOOK BELOW
  [0x1dce, 214], // COMBINING OGONEK ABOVE
  [0x031b, 216], // COMBINING HORN
  [0x302a, 218], // IDEOGRAPHIC LEVEL TONE MARK
  [0x0316, 220], // COMBINING GRAVE ACCENT BELOW
  [0x059a, 222], // HEBREW ACCENT YETIV
  [0x302e, 224], // HANGUL SINGLE DOT TONE MARK
  [0x1d16d, 226], // MUSICAL SYMBOL COMBINING AUGMENTATION DOT
  [0x05ae, 228], // HEBREW ACCENT ZINOR
  [0x0300, 230], // COMBINING GRAVE ACCENT
  [0x0315, 232], // COMBINING COMMA ABOVE RIGHT
  [0x035c, 233], // COMBINING DOUBLE BREVE BELOW
  [0x035d, 234], // COMBINING DOUBLE BREVE
  [0x0345, 240] // COMBINING GREEK YPOGEGRAMMENI
])

/** True when NFD reorders `a b` into `b a`, i.e. ccc(a) > ccc(b) > 0. This is
 *  the only channel ICU exposes for combining classes, and it is enough: NFC
 *  compares classes and never reads their numeric value. */
function reorders(a, b) {
  return (cp(a) + cp(b)).normalize('NFD') === cp(b) + cp(a)
}

function main() {
  console.log(`[nfc-tables] node ${process.version}, Unicode ${process.versions.unicode}`)

  const decompositions = []
  const stable = []
  for (let n = 0; n < 0x110000; n++) {
    if (isSurrogate(n)) {
      continue
    }
    const s = cp(n)
    const nfd = s.normalize('NFD')
    if (nfd === s) {
      stable.push(n)
    } else if (!isHangulSyllable(n)) {
      decompositions.push([n, chars(nfd)])
    }
  }

  // A class is non-zero iff the character reorders against one of the extremes:
  // it moves ahead of a low-class mark, or a high-class mark moves ahead of it.
  const LOW = 0x0334 // class 1
  const HIGH = 0x0345 // class 240
  const nonZero = stable.filter((n) => reorders(n, LOW) || reorders(HIGH, n))

  // Group by class (mutual non-reordering is the equality test) and sort the
  // groups ascending, again purely by what ICU does.
  const buckets = []
  for (const c of nonZero) {
    const hit = buckets.find((b) => !reorders(c, b[0]) && !reorders(b[0], c))
    if (hit) {
      hit.push(c)
    } else {
      buckets.push([c])
    }
  }
  buckets.sort((x, y) => (reorders(x[0], y[0]) ? 1 : -1))

  const labels = buckets.map((bucket) => {
    const named = [
      ...new Set(bucket.map((c) => CLASS_PROBES.get(c)).filter((v) => v !== undefined))
    ]
    if (named.length > 1) {
      throw new Error(`probes disagree inside one class: ${named.join(', ')}`)
    }
    return named[0] ?? null
  })
  // Unnamed classes take the free ladder slot between their labelled neighbours,
  // which keeps the numbers ordered even where no probe was supplied.
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== null) {
      continue
    }
    const below = labels.slice(0, i).reduce((acc, v) => v ?? acc, 0)
    const above = labels.slice(i + 1).find((v) => v !== null) ?? CCC_LADDER.at(-1) + 1
    const slot = CCC_LADDER.find((v) => v > below && v < above)
    if (slot === undefined) {
      throw new Error(`no combining-class label available between ${below} and ${above}`)
    }
    labels[i] = slot
    console.warn(`[nfc-tables] class of U+${buckets[i][0].toString(16)} inferred as ${slot}`)
  }
  for (let i = 1; i < labels.length; i++) {
    if (labels[i] <= labels[i - 1]) {
      throw new Error(`class labels out of order: ${labels[i - 1]} then ${labels[i]}`)
    }
  }

  const ccc = new Map()
  buckets.forEach((bucket, i) => {
    for (const c of bucket) {
      ccc.set(c, labels[i])
    }
  })

  const compositions = []
  for (const [n, nfd] of decompositions) {
    if (nfd.length < 2) {
      continue
    }
    const prefix = nfd.slice(0, -1).map(cp).join('').normalize('NFC')
    const prefixChars = chars(prefix)
    const last = nfd.at(-1)
    if (prefixChars.length !== 1) {
      continue
    }
    if ((prefix + cp(last)).normalize('NFC') !== cp(n)) {
      continue // composition-excluded
    }
    compositions.push([prefixChars[0], last, n])
  }
  compositions.sort((x, y) => x[0] - y[0] || x[1] - y[1])

  const cccRanges = []
  for (const c of [...ccc.keys()].sort((a, b) => a - b)) {
    const value = ccc.get(c)
    const tail = cccRanges.at(-1)
    if (tail && tail[1] === c - 1 && tail[2] === value) {
      tail[1] = c
    } else {
      cccRanges.push([c, c, value])
    }
  }

  const esc = (c) => `\\u{${c.toString(16).toUpperCase()}}`
  const lines = [
    '//! GENERATED by config/scripts/generate-unicode-nfc-tables.mjs — do not edit.',
    `//! Unicode ${process.versions.unicode} (ICU ${process.versions.icu}), measured out of the`,
    "//! same V8 that runs the TypeScript twin, so these tables ARE what the twin's",
    "//! `normalize('NFC')` does. Regenerate after a Node/ICU bump.",
    '',
    '// clippy::large_const_arrays — these are `static` so each lookup reads one copy.',
    '/// Full canonical decomposition, canonically ordered, sorted by code point.',
    '/// Hangul syllables are absent — they decompose algorithmically.',
    `pub(crate) static DECOMPOSITIONS: [(char, &str); ${decompositions.length}] = [`,
    ...decompositions.map(([n, nfd]) => `    ('${esc(n)}', "${nfd.map(esc).join('')}"),`),
    '];',
    '',
    '/// Canonical combining class as inclusive code-point ranges, sorted by start.',
    '/// Only characters with no canonical decomposition appear: nothing else can',
    '/// reach the ordering or composition passes.',
    `pub(crate) static COMBINING_CLASSES: [(char, char, u8); ${cccRanges.length}] = [`,
    ...cccRanges.map(([s, e, v]) => `    ('${esc(s)}', '${esc(e)}', ${v}),`),
    '];',
    '',
    '/// Primary composites `(first, second) -> composed`, sorted by the pair.',
    '/// Composition-excluded pairs are absent, so any hit is a legal composition.',
    `pub(crate) static COMPOSITIONS: [(char, char, char); ${compositions.length}] = [`,
    ...compositions.map(([a, b, n]) => `    ('${esc(a)}', '${esc(b)}', '${esc(n)}'),`),
    '];',
    ''
  ]

  fs.writeFileSync(OUT, lines.join('\n'))
  console.log(
    `[nfc-tables] ${decompositions.length} decompositions, ${cccRanges.length} class ranges ` +
      `over ${ccc.size} code points in ${buckets.length} classes, ${compositions.length} composites`
  )
  console.log(`[nfc-tables] wrote ${path.relative(process.cwd(), OUT)}`)
}

main()
