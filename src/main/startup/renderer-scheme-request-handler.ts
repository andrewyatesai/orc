// Pure (Electron-free) half of the orca:// renderer scheme: URL→file resolution,
// strict MIME typing, and the sender-origin check the IPC trust gates share.
// Why a custom scheme at all: Chromium never writes V8 code cache for file://
// documents; a standard+secure scheme with codeCache:true caches the ~3.8MiB
// eager renderer JS and the aterm engine wasm (moonshot Wave 2).
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

export const RENDERER_SCHEME = 'orca'
export const RENDERER_SCHEME_HOST = 'app'
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_SCHEME_HOST}`

/** URL for a built renderer page, e.g. rendererPageUrl('popout.html', 'view=kanban'). */
export function rendererPageUrl(page: string, search?: string): string {
  return `${RENDERER_ORIGIN}/${page}${search ? `?${search}` : ''}`
}

/**
 * Exact-origin check for IPC sender-trust gates. Deliberately NOT a
 * startsWith('orca') — orca:// is also the OS deep-link scheme, and only the
 * app host serves the privileged renderer. Node's URL treats orca: as
 * non-special (origin === 'null'), so compare protocol+host directly.
 */
export function isRendererSchemeSenderUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  return (
    url.protocol === `${RENDERER_SCHEME}:` &&
    url.hostname === RENDERER_SCHEME_HOST &&
    // Why: under a standard scheme, orca://app:8080 is a DIFFERENT origin than
    // orca://app — a ported URL must not pass the trust gate or be served.
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  )
}

// Why strict MIME: Chromium only code-caches scripts served as JavaScript, and
// instantiateStreaming requires application/wasm. Unknown types fail closed to
// octet-stream (downloads, never executes).
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  webm: 'video/webm',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg'
}

export function contentTypeForPath(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.')
  const extension = dotIndex === -1 ? '' : filePath.slice(dotIndex + 1).toLowerCase()
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

export type RendererSchemeHandlerOptions = {
  /** Directory the scheme serves (out/renderer). Resolved once; escapes rejected. */
  rootDir: string
  /**
   * Extra first-segment mounts, e.g. 'feature-wall-assets' → <resources dir>.
   * Same-origin so CSP 'self' covers them; each mount root is escape-checked
   * too. Read per-request so mounts registered after install still serve.
   */
  mounts?: ReadonlyMap<string, string>
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  })
}

/** True when resolvedPath is rootDir or inside it (win32 compares case-insensitively). */
function isInsideRoot(resolvedPath: string, resolvedRoot: string): boolean {
  const [child, root] =
    process.platform === 'win32'
      ? [resolvedPath.toLowerCase(), resolvedRoot.toLowerCase()]
      : [resolvedPath, resolvedRoot]
  return child === root || child.startsWith(root + sep)
}

/**
 * Serve orca://app/<path> from rootDir. Factored Electron-free so traversal,
 * MIME, and 404 behavior are unit-testable without an app boot.
 */
export function createRendererSchemeRequestHandler(
  options: RendererSchemeHandlerOptions
): (request: Request) => Promise<Response> {
  const defaultRoot = resolve(options.rootDir)

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, 'method not allowed')
    }
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return errorResponse(400, 'malformed url')
    }
    if (
      url.protocol !== `${RENDERER_SCHEME}:` ||
      url.hostname !== RENDERER_SCHEME_HOST ||
      url.port !== ''
    ) {
      return errorResponse(404, 'unknown host')
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return errorResponse(400, 'malformed path')
    }
    if (pathname.includes('\0')) {
      return errorResponse(400, 'malformed path')
    }
    if (pathname === '/' || pathname === '') {
      pathname = '/index.html'
    }

    const segments = pathname.split('/').filter((segment) => segment !== '')
    const mountDir = segments.length > 0 ? options.mounts?.get(segments[0]) : undefined
    const [root, relativeSegments] =
      mountDir !== undefined ? [resolve(mountDir), segments.slice(1)] : [defaultRoot, segments]

    const filePath = resolve(join(root, ...relativeSegments))
    // Why: decoded '..'/'%2e%2e' segments collapse in resolve(); one containment
    // check rejects every traversal shape, cross-platform.
    if (!isInsideRoot(filePath, root)) {
      return errorResponse(404, 'not found')
    }

    let size: number
    try {
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) {
        return errorResponse(404, 'not found')
      }
      size = fileStat.size
    } catch {
      return errorResponse(404, 'not found')
    }

    const headers = {
      'content-type': contentTypeForPath(filePath),
      'content-length': String(size)
    }
    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers })
    }
    // Stream: the aterm engine wasm alone is ~10MB; keep it off the main-process heap.
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream
    return new Response(body, { status: 200, headers })
  }
}
