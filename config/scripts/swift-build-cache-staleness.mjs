import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

// SwiftPM bakes ABSOLUTE paths into `.build` — module caches, link file lists,
// and the per-triple `description.json`. Rename or move the repository and those
// paths dangle, but SwiftPM does not notice: it fails mid-compile with
//
//   error: precompiled file '<new>/.build/.../SwiftShims-*.pcm' was compiled with
//   module cache path '<old>/.build/...', but the path is currently '<new>/.build/...'
//   error: missing required module 'SwiftShims'
//
// which names neither the rename nor the fix. This detects that state and clears
// the cache so the build self-heals instead of requiring the reader to know that
// `rm -rf .build` is the answer.

/**
 * Whether `.build` was produced under a different absolute path than `packagePath`.
 * Returns false for a fresh/absent cache — there is nothing stale to clear.
 */
export function swiftBuildCacheIsStale(packagePath) {
  const buildDir = path.join(packagePath, '.build')
  if (!existsSync(buildDir)) {
    return false
  }
  // Read the per-triple build descriptions: they record the package's absolute
  // path, so a cache built elsewhere simply will not mention the current one.
  let sawDescription = false
  for (const entry of readdirSync(buildDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    for (const config of ['release', 'debug']) {
      const description = path.join(buildDir, entry.name, config, 'description.json')
      if (!existsSync(description)) {
        continue
      }
      sawDescription = true
      let text = ''
      try {
        text = readFileSync(description, 'utf8')
      } catch {
        // Unreadable is itself suspect; treat it as stale rather than guessing.
        return true
      }
      if (text.includes(packagePath)) {
        return false
      }
    }
  }
  // Descriptions exist but none names this path ⇒ built somewhere else.
  return sawDescription
}

/**
 * Clear `.build` when it was produced under a different path. Returns true if it
 * cleared, so the caller can say so rather than silently costing a full rebuild.
 */
export function clearStaleSwiftBuildCache(packagePath, label) {
  if (!swiftBuildCacheIsStale(packagePath)) {
    return false
  }
  rmSync(path.join(packagePath, '.build'), { recursive: true, force: true })
  console.log(
    `[${label}] .build was produced under a different absolute path (the repository moved); ` +
      'cleared it so SwiftPM does not fail on a dangling module cache. This build will be a full one.'
  )
  return true
}
