import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RENDERER_ORIGIN,
  contentTypeForPath,
  createRendererSchemeRequestHandler,
  crossOriginIsolationEnabled,
  isRendererSchemeSenderUrl,
  rendererPageUrl
} from './renderer-scheme-request-handler'

describe('rendererPageUrl', () => {
  it('builds page URLs on the app host', () => {
    expect(rendererPageUrl('index.html')).toBe('orca://app/index.html')
    expect(rendererPageUrl('popout.html', 'view=kanban')).toBe('orca://app/popout.html?view=kanban')
  })
})

describe('isRendererSchemeSenderUrl', () => {
  it('accepts only the exact orca://app origin', () => {
    expect(isRendererSchemeSenderUrl('orca://app/index.html')).toBe(true)
    expect(isRendererSchemeSenderUrl(`${RENDERER_ORIGIN}/popout.html?view=kanban`)).toBe(true)
  })

  it('rejects other hosts, schemes, credentials, and garbage', () => {
    // Why: orca:// is also the deep-link scheme — orca://focus etc. must never pass a trust gate.
    expect(isRendererSchemeSenderUrl('orca://focus/term_x')).toBe(false)
    expect(isRendererSchemeSenderUrl('orca://apps/index.html')).toBe(false)
    expect(isRendererSchemeSenderUrl('orca://evil@app/index.html')).toBe(false)
    expect(isRendererSchemeSenderUrl('file:///renderer/index.html')).toBe(false)
    expect(isRendererSchemeSenderUrl('https://app/index.html')).toBe(false)
    expect(isRendererSchemeSenderUrl('not a url')).toBe(false)
    expect(isRendererSchemeSenderUrl('')).toBe(false)
  })
})

describe('contentTypeForPath', () => {
  it('maps the bundle extensions Chromium cares about', () => {
    expect(contentTypeForPath('/x/index.js')).toBe('text/javascript')
    expect(contentTypeForPath('/x/chunk.mjs')).toBe('text/javascript')
    expect(contentTypeForPath('/x/engine.wasm')).toBe('application/wasm')
    expect(contentTypeForPath('/x/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeForPath('/x/main.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeForPath('/x/icon.svg')).toBe('image/svg+xml')
    expect(contentTypeForPath('/x/font.woff2')).toBe('font/woff2')
    expect(contentTypeForPath('/x/pic.png')).toBe('image/png')
    expect(contentTypeForPath('/x/data.json')).toBe('application/json')
    expect(contentTypeForPath('/x/unknown.xyz')).toBe('application/octet-stream')
    expect(contentTypeForPath('/x/no-extension')).toBe('application/octet-stream')
  })
})

describe('crossOriginIsolationEnabled', () => {
  it("is OFF by default and enables only on the exact documented '1'", () => {
    expect(crossOriginIsolationEnabled({})).toBe(false)
    expect(crossOriginIsolationEnabled({ ORCA_CROSS_ORIGIN_ISOLATION: '0' })).toBe(false)
    expect(crossOriginIsolationEnabled({ ORCA_CROSS_ORIGIN_ISOLATION: '1' })).toBe(true)
  })
})

describe('createRendererSchemeRequestHandler', () => {
  let rootDir: string
  let outsideDir: string
  let handler: (request: Request) => Promise<Response>
  const mounts = new Map<string, string>()

  beforeEach(() => {
    rootDir = mkdtempSync(join(os.tmpdir(), 'orca-renderer-scheme-root-'))
    outsideDir = mkdtempSync(join(os.tmpdir(), 'orca-renderer-scheme-outside-'))
    writeFileSync(join(rootDir, 'index.html'), '<html></html>')
    mkdirSync(join(rootDir, 'assets'))
    writeFileSync(join(rootDir, 'assets', 'entry.js'), 'console.log(1)')
    writeFileSync(join(rootDir, 'assets', 'a b.js'), 'console.log(2)')
    writeFileSync(join(rootDir, 'assets', 'engine.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]))
    writeFileSync(join(rootDir, 'assets', 'main.css'), 'body{}')
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret')
    mounts.clear()
    handler = createRendererSchemeRequestHandler({ rootDir, mounts })
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  async function get(url: string): Promise<Response> {
    return handler(new Request(url))
  }

  it('serves files with the extension-mapped content type', async () => {
    const response = await get('orca://app/assets/entry.js')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript')
    expect(response.headers.get('content-length')).toBe('14')
    expect(await response.text()).toBe('console.log(1)')
  })

  it('serves index.html for the root path', async () => {
    const response = await get('orca://app/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toBe('<html></html>')
  })

  it('decodes percent-encoded paths and ignores the query string', async () => {
    const response = await get('orca://app/assets/a%20b.js?cache=1')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('console.log(2)')
  })

  it('returns 404 for missing files and directories', async () => {
    expect((await get('orca://app/missing.js')).status).toBe(404)
    expect((await get('orca://app/assets')).status).toBe(404)
  })

  it('rejects traversal out of the root, raw and encoded', async () => {
    const secret = `orca://app/${encodeURIComponent(join('..', outsideDir, 'secret.txt'))}`
    for (const url of [
      'orca://app/../secret.txt',
      'orca://app/assets/../../secret.txt',
      'orca://app/%2e%2e/%2e%2e/etc/passwd',
      'orca://app/..%2f..%2fetc%2fpasswd',
      secret
    ]) {
      const response = await get(url)
      expect(response.status, url).toBe(404)
    }
  })

  it('rejects null bytes and non-GET methods', async () => {
    expect((await get('orca://app/index.html%00.js')).status).toBe(400)
    const post = await handler(new Request('orca://app/index.html', { method: 'POST' }))
    expect(post.status).toBe(405)
  })

  it('rejects other hosts — deep-link shapes never resolve to files', async () => {
    expect((await get('orca://focus/term_x')).status).toBe(404)
    expect((await get('orca://evil/index.html')).status).toBe(404)
  })

  it('answers HEAD with headers only', async () => {
    const response = await handler(new Request('orca://app/assets/entry.js', { method: 'HEAD' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript')
    expect(await response.text()).toBe('')
  })

  describe('cross-origin isolation headers (moonshot rung 2)', () => {
    it('serves COOP+COEP on documents, including the root default', async () => {
      for (const url of ['orca://app/index.html', 'orca://app/']) {
        const response = await get(url)
        expect(response.headers.get('cross-origin-opener-policy'), url).toBe('same-origin')
        expect(response.headers.get('cross-origin-embedder-policy'), url).toBe('credentialless')
      }
    })

    it('serves COEP but not COOP on scripts — worker entrypoints need their own COEP', async () => {
      const response = await get('orca://app/assets/entry.js')
      expect(response.headers.get('cross-origin-embedder-policy')).toBe('credentialless')
      expect(response.headers.get('cross-origin-opener-policy')).toBeNull()
    })

    it('serves neither on non-script subresources', async () => {
      for (const url of ['orca://app/assets/engine.wasm', 'orca://app/assets/main.css']) {
        const response = await get(url)
        expect(response.headers.get('cross-origin-opener-policy'), url).toBeNull()
        expect(response.headers.get('cross-origin-embedder-policy'), url).toBeNull()
      }
    })

    it('keeps document headers on HEAD responses', async () => {
      const response = await handler(new Request('orca://app/index.html', { method: 'HEAD' }))
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin')
      expect(response.headers.get('cross-origin-embedder-policy')).toBe('credentialless')
    })

    it('omits headers on error responses', async () => {
      const response = await get('orca://app/missing.html')
      expect(response.status).toBe(404)
      expect(response.headers.get('cross-origin-opener-policy')).toBeNull()
      expect(response.headers.get('cross-origin-embedder-policy')).toBeNull()
    })

    it('serves no isolation headers anywhere at the opt-in default (off)', async () => {
      const disabled = createRendererSchemeRequestHandler({
        rootDir,
        mounts,
        crossOriginIsolation: crossOriginIsolationEnabled({})
      })
      for (const url of ['orca://app/index.html', 'orca://app/assets/entry.js']) {
        const response = await disabled(new Request(url))
        expect(response.status, url).toBe(200)
        expect(response.headers.get('cross-origin-opener-policy'), url).toBeNull()
        expect(response.headers.get('cross-origin-embedder-policy'), url).toBeNull()
      }
    })
  })

  it('serves mounts registered after handler creation, escape-checked', async () => {
    expect((await get('orca://app/extra/secret.txt')).status).toBe(404)
    mounts.set('extra', outsideDir)
    const response = await get('orca://app/extra/secret.txt')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('secret')
    // '..%2f' survives URL dot-segment normalization; containment must still reject it.
    expect((await get('orca://app/extra/..%2fsecret.txt')).status).toBe(404)
    expect((await get('orca://app/extra/..%2f..%2findex.html')).status).toBe(404)
  })
})
