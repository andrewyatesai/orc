import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearStaleSwiftBuildCache,
  swiftBuildCacheIsStale
} from './swift-build-cache-staleness.mjs'

// Guards the guard: a stale `.build` (one produced under the repo's previous
// absolute path) must be detected and cleared, and a healthy one must be left
// alone — a false positive here silently costs a full Swift rebuild every time.
const created = []

function makePackage() {
  const dir = mkdtempSync(path.join(tmpdir(), 'swift-cache-'))
  created.push(dir)
  return dir
}

function writeDescription(packagePath, recordedPath) {
  const dir = path.join(packagePath, '.build', 'arm64-apple-macosx', 'release')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'description.json'),
    JSON.stringify({ inputs: [`${recordedPath}/Package.swift`] }),
    'utf8'
  )
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop(), { recursive: true, force: true })
  }
})

describe('swift build cache staleness', () => {
  it('reports a cache recorded under a different absolute path as stale', () => {
    const pkg = makePackage()
    writeDescription(pkg, '/Users/someone/old-repo/native/computer-use-macos')
    expect(swiftBuildCacheIsStale(pkg)).toBe(true)
  })

  it('leaves a cache recorded under the current path alone', () => {
    const pkg = makePackage()
    writeDescription(pkg, pkg)
    expect(swiftBuildCacheIsStale(pkg)).toBe(false)
  })

  it('treats an absent or fresh cache as healthy — nothing to clear', () => {
    const pkg = makePackage()
    expect(swiftBuildCacheIsStale(pkg)).toBe(false)
    // A `.build` with no description yet (interrupted first build) is not stale.
    mkdirSync(path.join(pkg, '.build'), { recursive: true })
    expect(swiftBuildCacheIsStale(pkg)).toBe(false)
  })

  it('clears a stale cache and reports that it did', () => {
    const pkg = makePackage()
    writeDescription(pkg, '/Users/someone/old-repo/native/computer-use-macos')
    expect(clearStaleSwiftBuildCache(pkg, 'test')).toBe(true)
    expect(existsSync(path.join(pkg, '.build'))).toBe(false)
  })

  it('does not clear a healthy cache', () => {
    const pkg = makePackage()
    writeDescription(pkg, pkg)
    expect(clearStaleSwiftBuildCache(pkg, 'test')).toBe(false)
    expect(existsSync(path.join(pkg, '.build'))).toBe(true)
  })
})
