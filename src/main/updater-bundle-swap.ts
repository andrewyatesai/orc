import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs'
import { access, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse as parseYaml } from 'yaml'

const run = promisify(execFile)

/**
 * macOS in-place update by swapping the .app bundle, bypassing Squirrel.Mac.
 *
 * Why: Squirrel requires the running app's code signature to match the update's, so it
 * cannot update an ad-hoc-signed build at all — which is every local and unsigned-tier
 * build. Swapping the bundle ourselves makes code signing a distribution concern only,
 * and mirrors what aterm's updater already does (`crates/aterm-update`).
 *
 * Trust is tiered, like aterm's updater. SHA-512 over the artifact is ALWAYS enforced. An
 * Ed25519 signature over the feed is additionally enforced whenever a public key was
 * pinned at build time — that is the anchor that survives a repo-write attacker, which a
 * digest served by the same host does not.
 */

/** One entry of `latest-mac.yml`'s `files` list. */
type FeedFile = { url: string; sha512: string; size?: number }
type Feed = { version: string; files: FeedFile[] }

export type BundleSwapPlan = {
  version: string
  file: FeedFile
  /** Absolute path of the running `.app` bundle. */
  appRoot: string
}

/** Bytes downloaded so far out of the total the feed declared. */
export type DownloadProgress = { transferred: number; total: number; percent: number }

/** Absolute path of the running `.app`, or null when not running from a bundle. */
export function resolveAppBundleRoot(execPath: string): string | null {
  // <App>.app/Contents/MacOS/<exe> — three levels up is the bundle root.
  const root = resolve(dirname(execPath), '..', '..')
  return root.endsWith('.app') ? root : null
}

/**
 * Why: a quarantined app launched from a DMG/zip runs from a randomized read-only
 * `/private/var/folders/.../AppTranslocation` path, where swapping silently does nothing.
 */
export function isTranslocated(appRoot: string): boolean {
  return appRoot.includes('/AppTranslocation/')
}

/** Pick the asset matching this machine: prefer an arch-specific zip, else a universal one. */
export function selectMacZip(files: FeedFile[], arch: string): FeedFile | null {
  const zips = files.filter((f) => f.url.endsWith('.zip'))
  if (zips.length === 0) {
    return null
  }
  const archTag = arch === 'arm64' ? 'arm64' : 'x64'
  return (
    zips.find((f) => f.url.includes(archTag)) ?? zips.find((f) => !/arm64|x64/.test(f.url)) ?? null
  )
}

export function parseFeed(yml: string): Feed {
  const parsed = parseYaml(yml) as Partial<Feed> | null
  if (!parsed?.version || !Array.isArray(parsed.files)) {
    throw new Error('update feed is missing version or files')
  }
  return { version: parsed.version, files: parsed.files }
}

/**
 * Verify a detached Ed25519 signature over the feed's EXACT raw bytes.
 *
 * Why raw bytes, before any parse: a re-serialized or lossily-decoded document is not what
 * was signed, and handing unverified bytes to the YAML parser would make the parser itself
 * part of the attack surface.
 */
export function verifyFeedSignature(
  feedBytes: Uint8Array,
  signature: Uint8Array,
  pubkeyBase64: string
): boolean {
  const raw = Buffer.from(pubkeyBase64, 'base64')
  if (raw.length !== 32) {
    throw new Error('pinned update key is not a 32-byte Ed25519 public key')
  }
  // Ed25519 SPKI prefix — Node has no raw-key import for this curve.
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  return verifySignature(null, feedBytes, key, signature)
}

/** The build-time pinned feed key, or `''` when this build has no signature tier. */
export function pinnedUpdatePublicKey(): string {
  return typeof ORCA_UPDATE_PUBKEY === 'string' ? ORCA_UPDATE_PUBKEY : ''
}

async function sha512Base64(path: string): Promise<string> {
  const hash = createHash('sha512')
  await pipeline(createReadStream(path), hash)
  return hash.digest('base64')
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`fetch failed (${response.status}) for ${url}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Fetch the feed and, when a key is pinned, refuse it unless its detached signature
 * verifies. Fail-closed: with a key pinned, a missing or bad `.sig` installs nothing.
 */
export async function fetchVerifiedFeed(feedBaseUrl: string): Promise<Feed> {
  const feedUrl = `${feedBaseUrl}/latest-mac.yml`
  const bytes = await fetchBytes(feedUrl)
  const pubkey = pinnedUpdatePublicKey()
  if (pubkey) {
    let signature: Uint8Array
    try {
      signature = await fetchBytes(`${feedUrl}.sig`)
    } catch {
      throw new Error('update feed is unsigned but this build requires a signature')
    }
    if (!verifyFeedSignature(bytes, signature, pubkey)) {
      throw new Error('update feed failed signature verification')
    }
  }
  return parseFeed(Buffer.from(bytes).toString('utf8'))
}

/**
 * Stream a download to disk, reporting progress per chunk. The size cap comes from the
 * FEED, not from `content-length`, so a lying header can neither drive the UI nor let an
 * oversized body fill the disk before SHA-512 gets to reject it.
 */
export async function downloadWithProgress(
  url: string,
  destination: string,
  expectedSize: number | undefined,
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) for ${url}`)
  }
  const headerSize = Number(response.headers.get('content-length'))
  const declared = expectedSize ?? (Number.isFinite(headerSize) ? headerSize : 0)
  const total = Number.isFinite(declared) && declared > 0 ? declared : 0
  let transferred = 0

  const reader = response.body.getReader()
  const sink = createWriteStream(destination)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      transferred += value.byteLength
      if (total > 0 && transferred > total) {
        throw new Error('update download exceeded the size the feed declared')
      }
      if (!sink.write(value)) {
        await new Promise<void>((resolveDrain) => sink.once('drain', resolveDrain))
      }
      onProgress?.({
        transferred,
        total,
        percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0
      })
    }
    await new Promise<void>((resolveEnd, rejectEnd) => {
      sink.end((error?: Error | null) => (error ? rejectEnd(error) : resolveEnd()))
    })
  } catch (error) {
    sink.destroy()
    await reader.cancel().catch(() => undefined)
    throw error
  }

  // Why: a truncated transfer would otherwise reach the SHA-512 check as a plain
  // mismatch, hiding a network failure behind an integrity error.
  if (total > 0 && transferred !== total) {
    throw new Error('update download ended early')
  }
}

/** Resolve which build the feed offers, without downloading it. */
export async function planBundleSwap(
  feedBaseUrl: string,
  execPath: string
): Promise<BundleSwapPlan> {
  const appRoot = resolveAppBundleRoot(execPath)
  if (!appRoot) {
    throw new Error('not running from a .app bundle')
  }
  if (isTranslocated(appRoot)) {
    throw new Error('app is translocated; move it to /Applications before updating')
  }
  // Why: swapping needs write access to the PARENT dir (the bundle is replaced, not edited).
  await access(dirname(appRoot), fsConstants.W_OK).catch(() => {
    throw new Error(`no write access to ${dirname(appRoot)}`)
  })

  const feed = await fetchVerifiedFeed(feedBaseUrl)
  const file = selectMacZip(feed.files, process.arch)
  if (!file) {
    throw new Error(`no macOS zip in the feed for ${process.arch}`)
  }
  return { version: feed.version, file, appRoot }
}

/**
 * Download, verify, and stage the new bundle. Returns the staged `.app` path; nothing in
 * the live install has been touched yet, so a failure here is always a clean no-op.
 */
export async function stageBundleSwap(
  plan: BundleSwapPlan,
  feedBaseUrl: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), 'orca-update-'))
  try {
    const zipPath = join(workDir, 'update.zip')
    const url = plan.file.url.startsWith('http') ? plan.file.url : `${feedBaseUrl}/${plan.file.url}`
    await downloadWithProgress(url, zipPath, plan.file.size, onProgress)

    const actual = await sha512Base64(zipPath)
    if (actual !== plan.file.sha512) {
      throw new Error('update failed integrity check (sha512 mismatch)')
    }

    // Why: `ditto -x -k` is the only extractor that preserves the symlinks, xattrs, and
    // resource forks a signed .app needs; `unzip` corrupts bundles.
    const extractDir = join(workDir, 'extracted')
    await run('ditto', ['-x', '-k', zipPath, extractDir])

    const entry = (await readdir(extractDir)).find((name) => name.endsWith('.app'))
    if (!entry) {
      throw new Error('update archive contained no .app bundle')
    }
    const stagedApp = join(extractDir, entry)

    // Why: the zip carries com.apple.quarantine, which would make the swapped-in app
    // prompt Gatekeeper on every launch. We verified the bytes ourselves via sha512.
    await run('xattr', ['-dr', 'com.apple.quarantine', stagedApp]).catch(() => undefined)

    return stagedApp
  } catch (error) {
    await rm(workDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * Swap the staged bundle into place. The old bundle is moved aside first and restored if
 * the new one fails to land, so a failed swap never leaves the app missing.
 */
export async function applyBundleSwap(appRoot: string, stagedApp: string): Promise<void> {
  const retired = `${appRoot}.old-${Date.now()}`
  await rename(appRoot, retired)
  try {
    await rename(stagedApp, appRoot)
  } catch (error) {
    await rename(retired, appRoot).catch(() => undefined)
    throw error
  }
  await rm(retired, { recursive: true, force: true }).catch(() => undefined)
}

/** Relaunch the swapped bundle as a fresh process. The caller quits immediately after. */
export async function relaunchSwappedBundle(appRoot: string): Promise<void> {
  await run('open', ['-n', appRoot])
}

/** Remove `.old-*` bundles a previous interrupted swap left behind. */
export async function cleanRetiredBundles(appRoot: string): Promise<void> {
  const parent = dirname(appRoot)
  const base = appRoot.slice(parent.length + 1)
  const stale = (await readdir(parent).catch(() => [])).filter((name) =>
    name.startsWith(`${base}.old-`)
  )
  await Promise.all(stale.map((name) => rm(join(parent, name), { recursive: true, force: true })))
}

/** Read the feed's advertised version, through the same verification gate. */
export async function readFeedVersion(feedBaseUrl: string): Promise<string> {
  return (await fetchVerifiedFeed(feedBaseUrl)).version
}
