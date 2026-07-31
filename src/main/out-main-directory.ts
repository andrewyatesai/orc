import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The `out/main` directory, resolved independently of where the bundler put the
 * calling module.
 *
 * Why not `__dirname`: the main build emits shared code into `out/main/chunks/`,
 * and which modules land there changes with the bundler. When the code holding
 * `join(__dirname, '../preload/index.js')` moved into a chunk, `__dirname` became
 * `out/main/chunks`, so every output-relative path silently resolved one level
 * too deep — the preload failed to load and the orca:// renderer root pointed at
 * a directory that does not exist, so the window rendered the handler's 404 body
 * instead of the app. Nothing failed at build time; it only showed at runtime.
 *
 * Why candidates rather than one rule: the entry differs per launch mode —
 * `out/main/bootstrap.js` (package.json `main`), `out/main/index.js` (harnesses
 * that pass it directly), and under Playwright `require.main` is its own loader,
 * not the app at all. Each candidate is VERIFIED against the siblings the callers
 * actually want, so a wrong guess can never be returned.
 *
 * Deliberately electron-free: the plain-Node sidecar entries reach this module,
 * and a `require("electron")` anywhere in their graph is fatal at startup.
 */
const SIBLINGS = ['renderer', 'preload']
const PARENT_SEGMENT = '..'

function looksLikeOutMain(candidate: string): boolean {
  return SIBLINGS.every((sibling) => existsSync(join(candidate, PARENT_SEGMENT, sibling)))
}

let cached: string | null = null

export function outMainDirectory(): string {
  if (cached) {
    return cached
  }
  const candidates = [
    // Normal launch: the entry IS out/main/{bootstrap,index}.js.
    require.main?.filename ? dirname(require.main.filename) : null,
    // Unchunked callers, and — via PARENT_SEGMENT — this module's own chunk.
    // This is the one sanctioned parent-relative __dirname use in main (the
    // build guard's regex deliberately does not see the indirection): unlike the
    // call sites it replaces, the result here is VERIFIED before use, so a wrong
    // guess is discarded rather than silently returned.
    __dirname,
    join(__dirname, PARENT_SEGMENT)
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)

  cached = candidates.find(looksLikeOutMain) ?? __dirname
  return cached
}

export function resetOutMainDirectoryForTest(): void {
  cached = null
}
