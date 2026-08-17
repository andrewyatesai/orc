// Guards GHSA-2v37-7h3g-55p8: the shipped mobile lockfile must not pin a
// nanoid below the 3.3.18 fix. A regenerated lock could silently reintroduce it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MOBILE_LOCKFILE = fileURLToPath(new URL('../../mobile/pnpm-lock.yaml', import.meta.url))

// First patched release on the 3.x line for GHSA-2v37-7h3g-55p8.
const MIN_SAFE_3X = [3, 3, 18]

const parse = (v) => v.split('.').map(Number)
const below = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))

// Pure so a planted violation can be watched to fail without touching the real lock.
function vulnerableNanoidPins(lockText) {
  const found = new Set()
  for (const m of lockText.matchAll(/nanoid(?:@|: )(\d+\.\d+\.\d+)/g)) {
    const version = parse(m[1])
    if (version[0] === 3 && below(version, MIN_SAFE_3X)) {
      found.add(m[1])
    }
  }
  return [...found]
}

describe('mobile lockfile nanoid advisory guard', () => {
  it('the shipped mobile/pnpm-lock.yaml pins nanoid at or above the 3.3.18 fix', () => {
    expect(vulnerableNanoidPins(readFileSync(MOBILE_LOCKFILE, 'utf8'))).toEqual([])
  })

  it('fires when a lockfile reintroduces a pre-fix nanoid', () => {
    const planted = ['  nanoid@3.3.17:', '  nanoid@3.3.17: {}', '      nanoid: 3.3.17'].join('\n')
    expect(vulnerableNanoidPins(planted)).toEqual(['3.3.17'])
  })
})
