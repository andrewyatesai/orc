/**
 * The containment rule — `docs/reference/app-modes.md` §2.4.
 *
 * Mode-name comparisons and raw registry indexing are confined to
 * `src/shared/app-mode/*`. That is what keeps the mode diff grep-auditable to a
 * fixed file set and keeps a fourth mode down to one manifest. Without it,
 * `mode === 'alab'` spreads through the renderer and the manifest stops being
 * the description of what a mode does.
 *
 * Walks `git ls-files` rather than a directory scan, mirroring
 * `config/scripts/check-max-lines-ratchet.mjs` — so untracked scratch files
 * cannot fail the build and deleted files cannot pass it.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(__dirname, '..', '..', '..')
/**
 * The directories allowed to know mode names. `main/app-mode/` is included
 * because it owns the sidecar, and "did the user actually choose Classic, or
 * have they never chosen?" is the question that decides whether the file exists
 * at all — that is mode-module work, not a leak into unrelated code.
 */
const SANCTIONED_DIRS = ['src/shared/app-mode/', 'src/main/app-mode/']

function trackedSourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
    .split('\n')
    .filter((line) => line.length > 0)
}

function violations(pattern: RegExp, isAllowed: (file: string) => boolean): string[] {
  const found: string[] = []
  for (const file of trackedSourceFiles()) {
    if (isAllowed(file)) {
      continue
    }
    let contents: string
    try {
      contents = readFileSync(join(REPO_ROOT, file), 'utf8')
    } catch {
      continue
    }
    contents.split('\n').forEach((line, index) => {
      if (pattern.test(line)) {
        found.push(`${file}:${index + 1}: ${line.trim()}`)
      }
    })
  }
  return found
}

const inSanctionedDir = (file: string): boolean =>
  SANCTIONED_DIRS.some((dir) => file.startsWith(dir))

/** `alab` and `story-world` name nothing else in this tree, so any equality
 *  against them is a mode comparison. */
const UNAMBIGUOUS_MODE_COMPARISON = /[!=]==\s*['"](?:alab|story-world)['"]/
/** `classic` is ALSO an AppIconId (`app-icon.ts`), so matching the bare string
 *  flags legitimate icon code. Require a mode-named operand. */
const CLASSIC_MODE_COMPARISON = /\b\w*[mM]ode\b[^\n]{0,24}?[!=]==\s*['"]classic['"]/

describe('app mode containment', () => {
  it('no mode-name equality comparison outside the mode modules', () => {
    expect(violations(UNAMBIGUOUS_MODE_COMPARISON, inSanctionedDir)).toEqual([])
    expect(violations(CLASSIC_MODE_COMPARISON, inSanctionedDir)).toEqual([])
  })

  it('no raw APP_MODE_REGISTRY indexing outside the mode modules', () => {
    // Indexing with a caller-supplied value is exactly what turns an unknown
    // mode from a silent Classic into a crash. Use the capability reader.
    expect(violations(/APP_MODE_REGISTRY\s*\[/, inSanctionedDir)).toEqual([])
  })

  it('planting a violation is actually detected', () => {
    // A guard nobody has watched fail proves nothing (AGENTS.md). This proves the
    // matchers, not the tree: the same regexes, run against known-bad lines.
    const badIndex = /APP_MODE_REGISTRY\s*\[/
    expect(UNAMBIGUOUS_MODE_COMPARISON.test("  if (mode === 'alab') {")).toBe(true)
    expect(UNAMBIGUOUS_MODE_COMPARISON.test('  if (mode !== "story-world") {')).toBe(true)
    expect(CLASSIC_MODE_COMPARISON.test("  if (mode === 'classic') {")).toBe(true)
    expect(CLASSIC_MODE_COMPARISON.test("  if (appMode !== 'classic') {")).toBe(true)
    expect(badIndex.test('  const m = APP_MODE_REGISTRY[mode]')).toBe(true)
    // And that they do not fire on the legitimate shapes they must tolerate —
    // notably the app ICON id, which is also spelled 'classic'.
    expect(CLASSIC_MODE_COMPARISON.test("  if (iconId === 'classic') {")).toBe(false)
    expect(UNAMBIGUOUS_MODE_COMPARISON.test("  labelKey: 'appMode.alab',")).toBe(false)
    expect(badIndex.test('  resolveModeManifest(mode)')).toBe(false)
  })
})
