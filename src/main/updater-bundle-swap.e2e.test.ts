import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyBundleSwap, planBundleSwap, stageBundleSwap } from './updater-bundle-swap'

const run = promisify(execFile)

/**
 * End-to-end exercise of the macOS bundle swap against REAL artifacts: a genuine `.app`
 * bundle, a `ditto` archive in the same format electron-builder emits, a real HTTP feed,
 * and a real filesystem swap.
 *
 * Why this and not a full Orca build: every failure mode specific to this code lives in
 * the extract → verify → swap chain, and none of them need Electron. The one step left
 * unexercised is `relaunchSwappedBundle`, which would launch a GUI app from a test run.
 */

// `ditto`/`xattr` are macOS-only, so the whole flow is meaningless elsewhere.
const describeMac = process.platform === 'darwin' ? describe : describe.skip

describeMac('bundle swap end-to-end', () => {
  let root: string
  let server: Server
  let feedBaseUrl: string
  let installedApp: string

  /** Build a real, launchable .app whose executable prints `marker`. */
  async function makeApp(dir: string, name: string, marker: string): Promise<string> {
    const appPath = join(dir, `${name}.app`)
    const macos = join(appPath, 'Contents', 'MacOS')
    await mkdir(macos, { recursive: true })
    await writeFile(
      join(appPath, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>dev.alab.swaptest</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleVersion</key><string>${marker}</string>
</dict></plist>
`
    )
    const exe = join(macos, name)
    await writeFile(exe, `#!/bin/sh\necho ${marker}\n`)
    await chmod(exe, 0o755)
    // A symlink inside Contents — `unzip` mangles these, `ditto` preserves them. This is
    // the property that makes ditto mandatory for .app archives.
    await run('ln', ['-s', 'MacOS', join(appPath, 'Contents', 'AliasToMacOS')])
    return appPath
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'swap-e2e-'))

    // The "installed" app: v1, in a directory standing in for /Applications.
    const applications = join(root, 'Applications')
    await mkdir(applications, { recursive: true })
    installedApp = await makeApp(applications, 'SwapTest', 'v1')

    // The "release": v2, archived exactly as electron-builder archives a mac zip.
    const releaseDir = join(root, 'release')
    const buildDir = join(root, 'build')
    await mkdir(releaseDir, { recursive: true })
    await mkdir(buildDir, { recursive: true })
    const newApp = await makeApp(buildDir, 'SwapTest', 'v2')
    const zipPath = join(releaseDir, 'swaptest-0.2.0-arm64-mac.zip')
    await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', newApp, zipPath])

    const zipBytes = await readFile(zipPath)
    await writeFile(
      join(releaseDir, 'latest-mac.yml'),
      [
        'version: 0.2.0',
        'files:',
        '  - url: swaptest-0.2.0-arm64-mac.zip',
        `    sha512: ${createHash('sha512').update(zipBytes).digest('base64')}`,
        `    size: ${zipBytes.byteLength}`,
        ''
      ].join('\n')
    )

    server = createServer((req, res) => {
      const name = (req.url ?? '/').replace(/^\//, '').split('?')[0]
      const filePath = join(releaseDir, name)
      if (!existsSync(filePath)) {
        res.writeHead(404).end()
        return
      }
      void readFile(filePath).then((bytes) => {
        res.writeHead(200, { 'content-length': String(bytes.byteLength) }).end(bytes)
      })
    })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind a port')
    }
    feedBaseUrl = `http://127.0.0.1:${address.port}`
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    await rm(root, { recursive: true, force: true })
  })

  it('updates a real .app from v1 to v2 through the full download → verify → swap chain', async () => {
    const execPath = join(installedApp, 'Contents', 'MacOS', 'SwapTest')
    expect((await run(execPath)).stdout.trim()).toBe('v1')

    const plan = await planBundleSwap(feedBaseUrl, execPath)
    expect(plan.version).toBe('0.2.0')
    expect(plan.appRoot).toBe(installedApp)

    const progress: number[] = []
    const staged = await stageBundleSwap(plan, feedBaseUrl, ({ percent }) => progress.push(percent))
    expect(progress.at(-1)).toBe(100)
    // The live install must be untouched until the swap itself.
    expect((await run(execPath)).stdout.trim()).toBe('v1')

    await applyBundleSwap(plan.appRoot, staged)

    // The swapped-in binary is what actually runs — the real proof.
    expect((await run(execPath)).stdout.trim()).toBe('v2')
    // ditto preserved the symlink that `unzip` would have flattened.
    expect(existsSync(join(installedApp, 'Contents', 'AliasToMacOS'))).toBe(true)
  }, 60_000)

  it('refuses a tampered artifact and leaves the install untouched', async () => {
    const execPath = join(installedApp, 'Contents', 'MacOS', 'SwapTest')
    const before = (await run(execPath)).stdout.trim()

    const plan = await planBundleSwap(feedBaseUrl, execPath)
    const tampered = { ...plan, file: { ...plan.file, sha512: 'AAAA' } }
    await expect(stageBundleSwap(tampered, feedBaseUrl)).rejects.toThrow(/integrity check/)

    expect((await run(execPath)).stdout.trim()).toBe(before)
  }, 60_000)
})
