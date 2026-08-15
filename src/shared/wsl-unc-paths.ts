// WSL UNC paths on the Rust `orca_core::wsl_paths` core. This sits on
// `orca-dispatch-seam` rather than in one tree's binding directory because a WSL
// path is parsed on EVERY surface: main + cli (napi), the SSH relay (wasm via
// initSync), the renderer (wasm at ready), the mobile client and the Playwright
// specs (never bound at all).
//
// PRE-READY CONTRACT — `parity`, and it is FORCED. `parseWslUncPath`'s distro
// becomes the `wsl -d <distro>` target and its linuxPath becomes a real Windows
// filesystem path, a PTY cwd and a git working directory, so a wrong answer
// stats the wrong distro root. Both return types are already total — a
// `WslUncPathInfo | null` whose null is the twin's real "not a WSL path", and a
// bare boolean consumed inside `if`/`&&`/`.filter` — so there is no spare state a
// sentinel could occupy (ported-modules.md, "Signal at the level that has a
// spare state"; lifting to a list does not help, each answer decides ONE path).
// Mobile and the preload never bind the seam at all, so a sentinel would be
// those surfaces' permanent answer, not a boot blip. The fallback therefore
// re-runs the twin's own WSL_UNC_PATH_PATTERN, which makes pre-ready equal ready
// for every input.
//
// ONE MEASURED DIVERGENCE, corrected here instead of shipped. JS `.` excludes
// line terminators, so the twin REFUSED a UNC tail containing \n \r U+2028
// U+2029; `orca_core::wsl_paths` splits on '/' and accepts it. Differential over
// 368,420 inputs (exhaustive to length 4 over `/ \ w W s l . $ U \n \r space a`,
// plus 400k random paths carrying astral chars, BOM, U+212A, U+0130, U+017F, all
// cross-checked against the shipped wasm): the core never rejected what the twin
// accepted and never parsed it differently — the only disagreement was 54,352
// cases of exactly this class. It is reachable, since a path lifted off a
// terminal stream keeps a stray CR and a Linux filename may legally contain a
// newline, so `parseWslUncPath` folds the class back to the twin's null.
import { DispatchPayloadError } from './dispatch-payload-codec'
import { tryOrcaDispatch } from './orca-dispatch-seam'
import { WSL_UNC_PATH_PATTERN, type WslUncPathInfo } from './wsl-paths'

export type { WslUncPathInfo } from './wsl-paths'

/** The tail characters JS `.` cannot match, i.e. the whole divergent class. */
const CORE_ONLY_TAIL_CHARS = /[\n\r\u2028\u2029]/

/** The deleted twin's body, verbatim over the kept pattern. */
function legacyParseWslUncPath(path: string): WslUncPathInfo | null {
  const match = path.replace(/\\/g, '/').match(WSL_UNC_PATH_PATTERN)
  return match ? { distro: match[2], linuxPath: match[3] || '/' } : null
}

export function parseWslUncPath(path: string): WslUncPathInfo | null {
  // Computed before the crossing on purpose: a non-string path (the type says
  // string, but these also arrive from persisted JSON and off the wire) must
  // throw the same TypeError the twin threw, and the encoder would instead send
  // `undefined` as the documented no-arg call and get `null` back.
  const fallback = legacyParseWslUncPath(path)
  try {
    const answer = tryOrcaDispatch('wsl-paths', 'parseWslUncPath', path, { root: 'path' })
    // `null` here is "no binding" or the core's real "not a WSL path"; collapsing
    // them is safe only because this shim is parity — the core never rejects a
    // path the fallback parsed, so the fallback recomputes that same null.
    if (answer === null) {
      return fallback
    }
    const parsed = answer as WslUncPathInfo
    return CORE_ONLY_TAIL_CHARS.test(parsed.linuxPath) ? null : parsed
  } catch (error) {
    // Why the catch: a Windows directory name can hold an unpaired UTF-16
    // surrogate, so a path built from a real one can too. The codec refuses it
    // (it is not valid UTF-8 and cannot cross into Rust at all) and the twin
    // answered it without crossing anything, so the fallback is that same
    // answer. Only the encode rejection is caught; a DispatchCoreError still
    // propagates.
    if (error instanceof DispatchPayloadError) {
      return fallback
    }
    throw error
  }
}

// Composed rather than dispatched, exactly as the twin defined it, so the
// line-terminator correction above has ONE site and the predicate cannot drift
// from the parse it is supposed to summarise.
export function isWslUncPath(path: string): boolean {
  return parseWslUncPath(path) !== null
}

/** Convert an absolute Linux path in a known WSL distro to its Windows form.
 *  UNPORTED — orca_core has no Linux→Windows counterpart, so this stays TS on
 *  both paths; it lives here so WSL path conversion has one import site. */
export function toWindowsWslPath(linuxPath: string, distro: string): string {
  const mntMatch = linuxPath.match(/^\/mnt\/([a-z])(\/.*)?$/)
  if (mntMatch) {
    const rest = (mntMatch[2] || '').replace(/\//g, '\\')
    return `${mntMatch[1].toUpperCase()}:${rest || '\\'}`
  }

  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}

// Why (issue #8156): terminals in WSL worktrees print POSIX paths the Windows
// host cannot stat or open; rebase them onto the worktree's own UNC share so
// path-exists probes and file-open routing resolve them. Null when the worktree
// is not a WSL UNC path or the path is not POSIX-absolute.
export function mapPosixPathToWslWorktreeUncPath(
  posixPath: string,
  wslWorktreePath: string
): string | null {
  if (!posixPath.startsWith('/') || posixPath.startsWith('//')) {
    return null
  }
  const worktree = parseWslUncPath(wslWorktreePath)
  if (!worktree) {
    return null
  }
  // Why: keep the worktree's own share spelling (\\wsl$ vs \\wsl.localhost) so
  // mapped paths relativize against worktreePath without alias mismatches.
  const share = /^[\\/]{2}wsl\$[\\/]/i.test(wslWorktreePath) ? 'wsl$' : 'wsl.localhost'
  return `\\\\${share}\\${worktree.distro}${posixPath.replaceAll('/', '\\')}`
}

// Why: Windows folds the share (\\wsl$ aliases \\wsl.localhost), the distro, and
// drvfs /mnt/<drive> tails case-insensitively; the rest of the Linux path is not.
export function foldWslUncPathCaseInsensitiveParts(path: string): string | null {
  const parsed = parseWslUncPath(path)
  if (!parsed) {
    return null
  }
  // Why: the drvfs automount is literally lowercase /mnt — a case-variant like
  // /MNT is an ordinary case-sensitive Linux dir and must not be folded.
  const linuxPath = /^\/mnt\/[a-zA-Z](?:\/|$)/.test(parsed.linuxPath)
    ? parsed.linuxPath.toLowerCase()
    : parsed.linuxPath
  return `//wsl.localhost/${parsed.distro.toLowerCase()}${linuxPath === '/' ? '' : linuxPath}`
}
