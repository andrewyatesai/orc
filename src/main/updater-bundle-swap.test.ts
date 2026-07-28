import { generateKeyPairSync, sign as signBytes } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyBundleSwap,
  cleanRetiredBundles,
  downloadWithProgress,
  isTranslocated,
  parseFeed,
  resolveAppBundleRoot,
  selectMacZip,
  verifyFeedSignature
} from './updater-bundle-swap'

describe('resolveAppBundleRoot', () => {
  it('walks up from the executable to the bundle root', () => {
    expect(
      resolveAppBundleRoot('/Applications/Orca ALab Edition.app/Contents/MacOS/Orca ALab Edition')
    ).toBe('/Applications/Orca ALab Edition.app')
  })

  it('returns null when not running from a bundle', () => {
    expect(resolveAppBundleRoot('/usr/local/bin/orca')).toBeNull()
  })
})

describe('isTranslocated', () => {
  it('detects a Gatekeeper-translocated launch', () => {
    expect(
      isTranslocated('/private/var/folders/x/AppTranslocation/ABC-123/d/Orca ALab Edition.app')
    ).toBe(true)
  })

  it('accepts a normal install location', () => {
    expect(isTranslocated('/Applications/Orca ALab Edition.app')).toBe(false)
  })
})

describe('selectMacZip', () => {
  const arm = { url: 'orca-staging-0.3.0-arm64-mac.zip', sha512: 'a' }
  const intel = { url: 'orca-staging-0.3.0-x64-mac.zip', sha512: 'b' }
  const universal = { url: 'orca-mac.zip', sha512: 'c' }
  const dmg = { url: 'orca-macos-arm64.dmg', sha512: 'd' }

  it('prefers the matching arch', () => {
    expect(selectMacZip([intel, arm], 'arm64')).toBe(arm)
    expect(selectMacZip([intel, arm], 'x64')).toBe(intel)
  })

  it('falls back to a universal zip when no arch matches', () => {
    expect(selectMacZip([universal], 'arm64')).toBe(universal)
  })

  it('ignores non-zip assets', () => {
    expect(selectMacZip([dmg], 'arm64')).toBeNull()
  })
})

describe('parseFeed', () => {
  it('reads version and files', () => {
    const feed = parseFeed(
      ['version: 0.3.0', 'files:', '  - url: orca-arm64-mac.zip', '    sha512: abc'].join('\n')
    )
    expect(feed.version).toBe('0.3.0')
    expect(feed.files[0]?.url).toBe('orca-arm64-mac.zip')
  })

  it('rejects a feed without files', () => {
    expect(() => parseFeed('version: 0.3.0')).toThrow(/missing version or files/)
  })

  it('rejects an empty feed', () => {
    expect(() => parseFeed('')).toThrow(/missing version or files/)
  })
})

describe('verifyFeedSignature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  // Raw 32-byte key is the last 32 bytes of the SPKI DER.
  const pubkeyBase64 = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64')
  const feed = Buffer.from('version: 0.3.0\nfiles:\n  - url: a.zip\n    sha512: x\n')

  it('accepts a signature over the exact bytes', () => {
    const sig = signBytes(null, feed, privateKey)
    expect(verifyFeedSignature(feed, sig, pubkeyBase64)).toBe(true)
  })

  it('rejects a one-byte change anywhere in the feed', () => {
    const sig = signBytes(null, feed, privateKey)
    const tampered = Buffer.concat([feed.subarray(0, -1), Buffer.from('Y')])
    expect(verifyFeedSignature(tampered, sig, pubkeyBase64)).toBe(false)
  })

  it('rejects trailing whitespace, which a re-serializing verifier would miss', () => {
    const sig = signBytes(null, feed, privateKey)
    expect(verifyFeedSignature(Buffer.concat([feed, Buffer.from(' ')]), sig, pubkeyBase64)).toBe(
      false
    )
  })

  it('rejects a signature from a different key', () => {
    const other = generateKeyPairSync('ed25519')
    const sig = signBytes(null, feed, other.privateKey)
    expect(verifyFeedSignature(feed, sig, pubkeyBase64)).toBe(false)
  })

  it('refuses a malformed pinned key rather than treating it as absent', () => {
    expect(() => verifyFeedSignature(feed, Buffer.alloc(64), 'dG9vLXNob3J0')).toThrow(
      /32-byte Ed25519/
    )
  })
})

describe('applyBundleSwap', () => {
  let root: string
  let appRoot: string
  let stagedApp: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swap-test-'))
    appRoot = join(root, 'Orca.app')
    await mkdir(join(appRoot, 'Contents'), { recursive: true })
    await writeFile(join(appRoot, 'Contents', 'marker'), 'old')

    const staging = join(root, 'staging')
    stagedApp = join(staging, 'Orca.app')
    await mkdir(join(stagedApp, 'Contents'), { recursive: true })
    await writeFile(join(stagedApp, 'Contents', 'marker'), 'new')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('replaces the bundle and removes the retired copy', async () => {
    await applyBundleSwap(appRoot, stagedApp)
    expect(await readFile(join(appRoot, 'Contents', 'marker'), 'utf8')).toBe('new')
    expect((await readdir(root)).filter((n) => n.includes('.old-'))).toEqual([])
  })

  it('restores the original bundle when the staged one cannot land', async () => {
    await rm(stagedApp, { recursive: true, force: true })
    await expect(applyBundleSwap(appRoot, stagedApp)).rejects.toThrow()
    // Why: the whole point of moving aside rather than deleting — a failed swap must
    // never leave the user with no app.
    expect(existsSync(appRoot)).toBe(true)
    expect(await readFile(join(appRoot, 'Contents', 'marker'), 'utf8')).toBe('old')
  })

  it('sweeps bundles left behind by an interrupted swap', async () => {
    await mkdir(`${appRoot}.old-1700000000000`, { recursive: true })
    await mkdir(`${appRoot}.old-1700000000001`, { recursive: true })
    await cleanRetiredBundles(appRoot)
    expect((await readdir(root)).filter((n) => n.includes('.old-'))).toEqual([])
    expect(existsSync(appRoot)).toBe(true)
  })
})

describe('downloadWithProgress', () => {
  let root: string
  const originalFetch = globalThis.fetch

  const respondWith = (chunks: Uint8Array[], headers: Record<string, string> = {}): void => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(headers),
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk)
          }
          controller.close()
        }
      })
    }) as unknown as typeof fetch
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dl-test-'))
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  })

  it('reports incremental progress against the feed-declared size', async () => {
    respondWith([new Uint8Array(30), new Uint8Array(70)])
    const seen: number[] = []
    const dest = join(root, 'out.bin')
    await downloadWithProgress('https://example.test/a.zip', dest, 100, ({ percent }) => {
      seen.push(percent)
    })
    expect(seen).toEqual([30, 100])
    expect((await readFile(dest)).byteLength).toBe(100)
  })

  it('aborts a body larger than the feed declared, before any hash check', async () => {
    respondWith([new Uint8Array(200)])
    await expect(
      downloadWithProgress('https://example.test/a.zip', join(root, 'out.bin'), 100)
    ).rejects.toThrow(/exceeded the size/)
  })

  it('rejects a truncated transfer as a network failure, not an integrity failure', async () => {
    respondWith([new Uint8Array(40)])
    await expect(
      downloadWithProgress('https://example.test/a.zip', join(root, 'out.bin'), 100)
    ).rejects.toThrow(/ended early/)
  })

  it('ignores a lying content-length when the feed declared a size', async () => {
    respondWith([new Uint8Array(50)], { 'content-length': '999999' })
    const seen: number[] = []
    await downloadWithProgress(
      'https://example.test/a.zip',
      join(root, 'out.bin'),
      50,
      ({ percent }) => seen.push(percent)
    )
    expect(seen).toEqual([100])
  })
})

describe('install-mode wiring', () => {
  it('routes darwin to the in-place swap, not the manual download page', async () => {
    const { getUpdateInstallMode, usesSelfManagedCheck } = await import('./updater-install-policy')
    const mode = getUpdateInstallMode('darwin')
    expect(mode).toBe('bundle-swap')
    // Why: bundle-swap must bypass electron-updater's provider like 'manual' does...
    expect(usesSelfManagedCheck(mode)).toBe(true)
    // ...but must NOT be treated as 'manual' by the renderer, which would offer
    // "Download Manually" instead of an in-app update.
    expect(mode === 'manual').toBe(false)
  })
})
