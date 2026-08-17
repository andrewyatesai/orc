/**
 * What the play server is allowed to serve — `docs/reference/app-modes.md` §7.3.
 *
 * This is the largest new attack surface in Story World, so the containment is
 * a pure module with its own tests rather than a few lines inside a request
 * handler.
 *
 * **It is modelled on `filesystem-auth.ts`'s `resolveAuthorizedPath`, not on
 * `isAllowedStaticWebPath`.** That existing guard cannot survive a
 * workspace-rooted server: what remains of it is a lexical
 * `relative(root, abs).startsWith('..')` check with no `realpath`, which a
 * symlink walks straight through.
 *
 * The Windows rules are not hypothetical. The sanitizer this replaces rejected
 * only NUL bytes, backslashes and `..`, which leaves device names (`CON`,
 * `NUL.js`), NTFS alternate data streams (`game.js::$DATA`) and trailing
 * dot/space filenames — all of which Windows resolves to something other than
 * the file that was asked for.
 *
 * NOT YET WIRED, and that is the intended state: `decidePlayPath` and
 * `isAllowedPlayHost` are referenced only by this file and its tests, because
 * the play server they guard is not built yet. The guard lands before the
 * surface it contains, on purpose. Noted here because the Rust port and the
 * green `policy` parity module make it look live — `decideFleetGrant`, in that
 * same parity module, IS wired (`main/runtime/fleet-grant-registry.ts`), so the
 * module being green says nothing about this half.
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Shared with the renderer's reload filter so the two cannot disagree about
 *  what counts as part of a game. */
export const STORY_PLAY_EXTENSIONS: readonly string[] = [
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.mp3',
  '.wav',
  '.ogg',
  '.woff',
  '.woff2'
]

/** `CON.js` and `con` both resolve to the console device on Windows. */
const WINDOWS_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
])

/**
 * The longest request path a world may ask for, in BYTES.
 *
 * Mirrors `orca_policy::MAX_REQUEST_PATH_BYTES`, and the two are held together
 * by `# max-request-path-bytes:` in `rust/crates/orca-policy/parity-corpus.txt`
 * — each side's test asserts its own constant equals the declared one, so a
 * change on one side reddens the other. Bytes, not `.length`, because the Rust
 * side caps `path.len()`; a multi-byte path would otherwise cap differently.
 */
export const MAX_REQUEST_PATH_BYTES = 4096

export type PlayPathDecision =
  | { allowed: true; absolutePath: string }
  | {
      allowed: false
      reason:
        | 'traversal'
        | 'escapes-root'
        | 'nul-byte'
        | 'windows-device'
        | 'alternate-data-stream'
        | 'trailing-dot-or-space'
        | 'extension-not-allowed'
        | 'unresolvable'
    }

function hasWindowsDeviceName(segment: string): boolean {
  // The device name binds on the STEM, so `NUL.js` is still the null device.
  const stem = segment.split('.')[0]?.toLowerCase() ?? ''
  return WINDOWS_DEVICE_NAMES.has(stem)
}

/**
 * `realpath` is applied to the RESOLVED path and compared against the realpath
 * of the root, so a symlink inside the world pointing at `~/.ssh` fails
 * containment even though its lexical path looks fine.
 *
 * `realpath` is injected so the rules are testable without a filesystem.
 */
export function decidePlayPath(args: {
  root: string
  requestPath: string
  realpath?: (path: string) => string
}): PlayPathDecision {
  const requested = decodeSafely(args.requestPath)
  if (requested === null) {
    return { allowed: false, reason: 'unresolvable' }
  }
  if (requested.includes('\0')) {
    return { allowed: false, reason: 'nul-byte' }
  }

  const segments = requested.split(/[/\\]+/).filter((segment) => segment.length > 0)
  for (const segment of segments) {
    if (segment === '..') {
      return { allowed: false, reason: 'traversal' }
    }
    if (segment.includes(':')) {
      // `game.js::$DATA` reads the file's default stream; other stream names
      // read hidden content entirely.
      return { allowed: false, reason: 'alternate-data-stream' }
    }
    if (/[. ]$/.test(segment)) {
      // Windows silently strips these, so `secret.js.` opens `secret.js`.
      return { allowed: false, reason: 'trailing-dot-or-space' }
    }
    if (hasWindowsDeviceName(segment)) {
      return { allowed: false, reason: 'windows-device' }
    }
  }

  const relativePath = segments.join('/')
  const extension = extensionOf(relativePath)
  if (!STORY_PLAY_EXTENSIONS.includes(extension)) {
    return { allowed: false, reason: 'extension-not-allowed' }
  }

  const absolute = resolve(join(args.root, relativePath))
  // Lexical containment first — cheap, and it rejects the obvious cases before
  // any syscall.
  if (!isAbsolute(absolute) || relative(args.root, absolute).startsWith('..')) {
    return { allowed: false, reason: 'escapes-root' }
  }

  // Then the real one. A lexical check alone is what `isAllowedStaticWebPath`
  // does, and it is exactly what a symlink defeats.
  const real = args.realpath ?? realpathSync
  let realRoot: string
  let realTarget: string
  try {
    realRoot = real(args.root)
    realTarget = real(absolute)
  } catch {
    return { allowed: false, reason: 'unresolvable' }
  }
  const realRelative = relative(realRoot, realTarget)
  if (realRelative.startsWith('..') || isAbsolute(realRelative)) {
    return { allowed: false, reason: 'escapes-root' }
  }

  return { allowed: true, absolutePath: realTarget }
}

function decodeSafely(requestPath: string): string | null {
  const path = requestPath.split('?')[0] ?? ''
  // Capped before decoding, so the work done on a hostile path is bounded too.
  // No real game asset path is near this long.
  if (Buffer.byteLength(path, 'utf8') > MAX_REQUEST_PATH_BYTES) {
    return null
  }
  try {
    // A single decode: double-encoded traversal must not be decoded twice into
    // a live `..`.
    return decodeURIComponent(path)
  } catch {
    return null
  }
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.')
  return index === -1 ? '' : path.slice(index).toLowerCase()
}

/** Only loopback, and only the host we minted. A `Host` header naming anything
 *  else means the request reached us through something we do not control. */
export function isAllowedPlayHost(host: string | undefined, expectedPort: number): boolean {
  if (!host) {
    return false
  }
  const [name, port] = host.split(':')
  if (Number(port) !== expectedPort) {
    return false
  }
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}
