import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UPDATE_FEED_REPO_SLUG } from '../../src/main/updater-feed-endpoints'
import { ORCA_ALAB_PUBLIC_REPOSITORY_SLUG } from '../../src/shared/repository-endpoints'
import { DEFAULT_RELEASE_REPOSITORY } from './release-repository.mjs'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')
const electronBuilderNativeRebuild = require('./electron-builder-native-rebuild.cjs')

// Why: the config reads its identity, signing tier, and version override from the
// environment at require time, so a re-require has to start from a cleared slate —
// an ambient ORCA_MAC_RELEASE or ORCA_LOCAL_BUILD_VERSION would leak into asserts.
const MUTABLE_BUILD_ENV = [
  'ORCA_MAC_RELEASE',
  'ORCA_MAC_NOTARIZE',
  'ORCA_MAC_SIGN_IDENTITY',
  'ORCA_MAC_BUILD_ARCHES',
  'ORCA_PUBLIC_IDENTITY',
  'ORCA_LOCAL_BUILD_VERSION'
]

/** Re-requires the config under a temporary env, then restores env and module cache. */
function reloadConfigWithEnv(envOverrides, run) {
  const configPath = require.resolve('../electron-builder.config.cjs')
  const originals = Object.fromEntries(
    [...MUTABLE_BUILD_ENV, ...Object.keys(envOverrides)].map((key) => [key, process.env[key]])
  )
  try {
    for (const key of MUTABLE_BUILD_ENV) {
      delete process.env[key]
    }
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    delete require.cache[configPath]
    return run(require('../electron-builder.config.cjs'))
  } finally {
    for (const [key, original] of Object.entries(originals)) {
      if (original === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = original
      }
    }
    delete require.cache[configPath]
    require('../electron-builder.config.cjs')
  }
}

describe('electron-builder config', () => {
  // Why: local-build discovery rejects any build whose recorded appId differs from
  // the compatibility contract, so the packaged identity must stay in step with it.
  // The fork packages under the `.staging` suffix, so pin that exact relationship.
  it('keeps the packaged app identity aligned with local-build validation', () => {
    const contractAppId = require('../../src/shared/local-build-compatibility-contract.json').appId
    expect(electronBuilderConfig.appId).toBe(`${contractAppId}.staging`)
    reloadConfigWithEnv({ ORCA_PUBLIC_IDENTITY: '1' }, (config) => {
      expect(config.appId).toBe(contractAppId)
    })
  })

  // Why: audit F14/G3 — wearing public Orca's identity would share userData,
  // the single-instance lock, and the installer namespace with the public app.
  it('defaults to the staging fork identity', () => {
    expect(electronBuilderConfig.appId).toBe('com.stablyai.orca.staging')
    expect(electronBuilderConfig.productName).toBe('Orca ALab Edition')
    // Why: Electron derives app.name/userData from the packaged package.json,
    // so the fork productName must be injected there via extraMetadata.
    expect(electronBuilderConfig.extraMetadata).toEqual({ productName: 'Orca ALab Edition' })
    // Why: Electron resolves helper bundles as "<CFBundleName> Helper.app", but
    // electron-builder strips ':' from bundle filenames only — a colon in the
    // fork productName crashes packaged launches with "Unable to find helper app".
    expect(electronBuilderConfig.productName).not.toContain(':')
  })

  it('keeps mac zip asset names space-free for the fork identity', () => {
    // Why: GitHub rewrites spaces in release asset names, so a productName
    // with a space would make latest-mac.yml reference a 404ing filename.
    expect(electronBuilderConfig.mac.artifactName).toBe(
      'orca-staging-${version}-${arch}-mac.${ext}'
    )
    reloadConfigWithEnv({ ORCA_PUBLIC_IDENTITY: '1' }, (config) => {
      expect(config.mac.artifactName).toBeUndefined()
    })
  })

  it('keeps ALab macOS artifacts deterministically ad-hoc signed', () => {
    expect(electronBuilderConfig.mac.identity).toBe('-')
    expect(electronBuilderConfig.mac.hardenedRuntime).toBe(false)
    expect(electronBuilderConfig.mac.notarize).toBe(false)
    expect(electronBuilderConfig.forceCodeSigning).toBe(false)
    reloadConfigWithEnv(
      {
        ORCA_MAC_RELEASE: '1',
        CSC_LINK: '/tmp/production-signing-certificate.p12',
        CSC_NAME: 'Developer ID Application: Must Not Be Used'
      },
      (config) => {
        expect(config.mac.identity).toBe('-')
        expect(config.mac.hardenedRuntime).toBe(false)
        expect(config.mac.notarize).toBe(false)
        expect(config.forceCodeSigning).toBe(false)
      }
    )
  })

  it('restores the upstream identity only under ORCA_PUBLIC_IDENTITY=1', () => {
    reloadConfigWithEnv({ ORCA_PUBLIC_IDENTITY: '1' }, (config) => {
      expect(config.appId).toBe('com.stablyai.orca')
      expect(config.productName).toBe('Orca')
      // Why: public-identity diff builds must keep packaged metadata
      // byte-compatible with upstream — no extraMetadata injection.
      expect(config.extraMetadata).toBeUndefined()
    })
  })

  it('does not claim an upstream Windows publisher for ALab artifacts', () => {
    expect(electronBuilderConfig.win.signtoolOptions).toBeUndefined()
    reloadConfigWithEnv({ ORCA_PUBLIC_IDENTITY: '1' }, (config) => {
      expect(config.win.signtoolOptions.publisherName).toBe('SignPath Foundation')
    })
  })

  // Why: releases and the update feed both live on the public repo; the publish
  // target must match UPDATE_FEED_REPO_SLUG.
  it('publishes to the public release repo', () => {
    expect(electronBuilderConfig.publish).toMatchObject({
      provider: 'github',
      owner: 'alabsystems',
      repo: 'orca-alab'
    })
    reloadConfigWithEnv({ ORCA_PUBLIC_IDENTITY: '1' }, (config) => {
      expect(config.publish).toMatchObject({ owner: 'alabsystems', repo: 'orca-alab' })
    })
    const builderRepository = `${electronBuilderConfig.publish.owner}/${electronBuilderConfig.publish.repo}`
    expect(builderRepository).toBe(UPDATE_FEED_REPO_SLUG)
    expect(builderRepository).toBe(DEFAULT_RELEASE_REPOSITORY)
    expect(builderRepository).toBe(ORCA_ALAB_PUBLIC_REPOSITORY_SLUG)
  })

  // Why: audit F2 — afterPack must fail on foreign-arch cargo binaries instead
  // of shipping a bundle whose daemon/addon can never load.
  it('fails afterPack when bundled cargo binaries do not match the bundle arch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-bundle-arch-afterpack-'))
    try {
      const resourcesDir = join(root, 'linux-unpacked', 'resources')
      await mkdir(resourcesDir, { recursive: true })
      const arm64Elf = Buffer.alloc(64)
      arm64Elf.writeUInt32BE(0x7f454c46, 0)
      arm64Elf[4] = 2
      arm64Elf[5] = 1
      arm64Elf.writeUInt16LE(0xb7, 18) // aarch64
      await writeFile(join(resourcesDir, 'orca-daemon'), arm64Elf)
      await writeFile(join(resourcesDir, 'orca_node.node'), arm64Elf)

      await expect(
        electronBuilderConfig.afterPack({
          appOutDir: join(root, 'linux-unpacked'),
          electronPlatformName: 'linux',
          arch: 1 // electron-builder Arch.x64
        })
      ).rejects.toThrow(/requires x64/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('excludes repo-only source trees from app.asar', () => {
    expect(electronBuilderConfig.files).toEqual(
      expect.arrayContaining([
        '!src{,/**/*}',
        '!config{,/**/*}',
        '!docs{,/**/*}',
        '!mobile{,/**/*}',
        '!native{,/**/*}',
        '!skills{,/**/*}',
        '!skill-guides{,/**/*}',
        '!skill-stubs{,/**/*}',
        '!resources/skills/**',
        '!tests{,/**/*}',
        '!examples{,/**/*}',
        '!pr-evidence{,/**/*}',
        '!Casks{,/**/*}',
        '!{AGENTS.md,CLAUDE.md,DEVELOPING.md,THIRD-PARTY-NOTICES.md,bundle-size-progress.md,ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md,ORCHESTRATION_STRUCTURED_OUTPUT_DESIGN.md}',
        '!out/**/*.test.js',
        '!resources/plugins/launch/**'
      ])
    )
  })

  // Why: `files` is an all-negation list, so electron-builder's default `**/*` packs
  // anything without an explicit `!` entry — examples/ landed without one and shipped
  // hostile-panel, the adversarial containment fixture, into 1.4.160-rc.3's app.asar.
  // Drive the real matcher: pinning the pattern string cannot prove it excludes the tree.
  it('keeps plugin authoring examples out of app.asar', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    // copyFiles() prepends this itself once the pattern list is all-negation.
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const packs = (repoPath) => isPacked(join('/app', repoPath), { isDirectory: () => false })

    for (const authoringOnly of [
      'examples/plugins/hostile-panel/panel.html',
      'examples/plugins/hostile-panel/orca-plugin.json',
      'examples/plugins/hello-orca/main.mjs',
      'examples/plugins/hello-orca/orca-plugin.json'
    ]) {
      expect(packs(authoringOnly)).toBe(false)
    }
    // The negation stays anchored at the app root, so nested `examples` segments still ship.
    expect(packs('out/main/examples/index.js')).toBe(true)
  })

  it('keeps runtime resources available through extraResources', () => {
    const bundledPluginResources = expect.objectContaining({
      from: 'resources/plugins/launch',
      to: 'plugins/launch'
    })
    for (const platform of ['mac', 'linux', 'win']) {
      expect(electronBuilderConfig[platform].extraResources).toContainEqual({
        from: 'resources/skills',
        to: 'skills'
      })
      expect(electronBuilderConfig[platform].extraResources).toEqual(
        expect.arrayContaining([bundledPluginResources])
      )
    }
    expect(electronBuilderConfig.mac.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/computer-use-macos/.build/release/Orca Computer Use.app',
          to: 'Orca Computer Use.app'
        })
      ])
    )
    expect(electronBuilderConfig.linux.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/computer-use-linux/runtime.py',
          to: 'computer-use-linux/runtime.py'
        })
      ])
    )
    expect(electronBuilderConfig.win.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/computer-use-windows/runtime.ps1',
          to: 'computer-use-windows/runtime.ps1'
        }),
        expect.objectContaining({
          from: 'native/windows-cli-launcher/.build/orca.exe',
          to: 'bin/orca.exe'
        })
      ])
    )
  })

  it('ships the terminal addon to the resources root on every platform', () => {
    // Why: the daemon loads the native terminal engine from
    // process.resourcesPath/orca_node.node in packaged apps on mac/linux/win.
    const terminalAddon = expect.objectContaining({
      from: 'native/orca-node/orca_node.node',
      to: 'orca_node.node'
    })
    expect(electronBuilderConfig.mac.extraResources).toEqual(
      expect.arrayContaining([terminalAddon])
    )
    expect(electronBuilderConfig.linux.extraResources).toEqual(
      expect.arrayContaining([terminalAddon])
    )
    expect(electronBuilderConfig.win.extraResources).toEqual(
      expect.arrayContaining([terminalAddon])
    )
  })

  // Why: the Windows CLI shim is delivered only via extraResources to
  // resources/bin/orca.cmd (beside the native resources/bin/orca.exe). If the
  // source tree is also packed into app.asar it gets extracted by
  // asarUnpack:['resources/**'] to app.asar.unpacked/resources/win32/bin/orca.cmd,
  // a duplicate with no adjacent orca.exe that fails to launch (#7351).
  it('keeps the Windows CLI shim source tree out of app.asar', () => {
    expect(electronBuilderConfig.files).toEqual(
      expect.arrayContaining(['!resources/win32{,/**/*}'])
    )
    // Regression guard: the working shim must still ship via extraResources.
    expect(electronBuilderConfig.win.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'resources/win32/bin/orca.cmd',
          to: 'bin/orca.cmd'
        })
      ])
    )
  })

  // Why: on macOS 26 UNUserNotificationCenter aborts for executables launched
  // from Contents/Resources, so the helper must ship in Contents/MacOS (#7929).
  it('ships the mac notification-status helper in Contents/MacOS, not Resources', () => {
    expect(electronBuilderConfig.mac.extraFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/notification-status-macos/.build/release/orca-notification-status',
          to: 'MacOS/orca-notification-status'
        })
      ])
    )
    expect(electronBuilderConfig.mac.extraResources).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ to: 'orca-notification-status' })])
    )
  })

  it('unpacks the compiled CommonJS boundary with CLI runtime files', () => {
    expect(electronBuilderConfig.asarUnpack).toEqual(
      expect.arrayContaining([
        'out/package.json',
        'out/cli/**',
        'out/shared/**',
        'out/main/claude-accounts/keychain.js'
      ])
    )
  })

  // Why: without the unpacked entry the watcher client silently falls back to
  // in-process @parcel/watcher, reintroducing the #7547 main-process crash.
  it('unpacks the forked parcel-watcher process entry', () => {
    expect(electronBuilderConfig.asarUnpack).toEqual(
      expect.arrayContaining(['out/main/parcel-watcher-process-entry.js'])
    )
  })

  it('keeps the worker-thread hang watchdog inside app.asar', () => {
    expect(electronBuilderConfig.asarUnpack).not.toContain(
      'out/main/main-thread-hang-watchdog-entry.js'
    )
  })

  it('uses the multi-size icon source for Linux packages', () => {
    expect(electronBuilderConfig.linux.icon).toBe('resources/build/icon.icns')
  })

  it('matches the Linux desktop entry to Electron window class', () => {
    expect(electronBuilderConfig.linux.desktop.entry.StartupWMClass).toBe('orca')
  })

  it('uses AppImage and deb as local Linux targets without changing existing artifact names', () => {
    expect(electronBuilderConfig.linux.target).toEqual(['AppImage', 'deb'])
    expect(electronBuilderConfig.appImage.artifactName).toBe('orca-linux.${ext}')
    expect(electronBuilderConfig.deb.artifactName).toBe('orca-ide_${version}_${arch}.${ext}')
    expect(electronBuilderConfig.rpm).toMatchObject({
      packageName: 'orca-ide',
      artifactName: 'orca-ide-${version}.${arch}.${ext}'
    })
  })

  it('uses a distinct AppImage name for Linux arm64 release uploads', () => {
    const configPath = require.resolve('../electron-builder.config.cjs')
    const original = process.env.ORCA_LINUX_ARM64_RELEASE
    try {
      delete require.cache[configPath]
      process.env.ORCA_LINUX_ARM64_RELEASE = '1'
      expect(require('../electron-builder.config.cjs').appImage.artifactName).toBe(
        'orca-linux-arm64.${ext}'
      )
    } finally {
      if (original === undefined) {
        delete process.env.ORCA_LINUX_ARM64_RELEASE
      } else {
        process.env.ORCA_LINUX_ARM64_RELEASE = original
      }
      delete require.cache[configPath]
      require('../electron-builder.config.cjs')
    }
  })

  it('builds only the host arch for local mac builds so no Rosetta-demanding app is emitted', () => {
    const expectedHostArch = process.arch === 'x64' ? 'x64' : 'arm64'
    for (const target of electronBuilderConfig.mac.target) {
      expect(target.arch).toEqual([expectedHostArch])
    }
  })

  it('ships both Intel and Apple-silicon slices on the mac release path', () => {
    reloadConfigWithEnv({ ORCA_MAC_RELEASE: '1' }, (releaseConfig) => {
      for (const target of releaseConfig.mac.target) {
        expect(target.arch).toEqual(['x64', 'arm64'])
      }
    })
  })

  it('lets ORCA_MAC_BUILD_ARCHES override the mac target arches', () => {
    reloadConfigWithEnv({ ORCA_MAC_BUILD_ARCHES: 'x64, arm64' }, (overridden) => {
      for (const target of overridden.mac.target) {
        expect(target.arch).toEqual(['x64', 'arm64'])
      }
    })
  })

  // Why: the local semver override shares ONE extraMetadata object with the fork
  // productName injection — a regression that replaces instead of merging would
  // silently drop the userData/single-instance isolation.
  it('overrides packaged semver only for local macOS builds', () => {
    reloadConfigWithEnv({ ORCA_LOCAL_BUILD_VERSION: '1.4.159-rc.0.local.123.abc' }, (config) => {
      expect(config.extraMetadata).toEqual({
        productName: 'Orca ALab Edition',
        version: '1.4.159-rc.0.local.123.abc'
      })
    })
  })

  it('never applies local semver to release packaging', () => {
    reloadConfigWithEnv(
      { ORCA_LOCAL_BUILD_VERSION: '1.4.159-local.123.abc', ORCA_MAC_RELEASE: '1' },
      (config) => {
        expect(config.extraMetadata.version).toBeUndefined()
      }
    )
  })

  it('uses Orca native rebuild hook instead of electron-builder default rebuild', () => {
    expect(electronBuilderConfig.beforeBuild).toBe(electronBuilderNativeRebuild)
    expect(electronBuilderConfig.npmRebuild).toBe(true)
  })

  it('fails when the packaged resources directory is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-electron-builder-config-'))
    try {
      await expect(
        electronBuilderConfig.afterPack({
          appOutDir: root,
          electronPlatformName: 'win32'
        })
      ).rejects.toThrow(/Missing packaged resources directory/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'marks packaged Unix CLI launchers executable',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-electron-builder-config-'))
      try {
        const resourcesDir = join(root, 'linux-unpacked', 'resources')
        const launcherPath = join(resourcesDir, 'bin', 'orca-ide')
        await mkdir(join(resourcesDir, 'bin'), { recursive: true })
        await cp(
          join(process.cwd(), 'resources', 'plugins', 'launch'),
          join(resourcesDir, 'plugins', 'launch'),
          { recursive: true }
        )
        await mkdir(join(resourcesDir, 'node_modules', 'zod', 'src'), { recursive: true })
        // Why: afterPack probes the packaged skills CLI, so the fixture needs a
        // real unpacked out/cli like a produced package layout.
        const unpackedCliDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'cli')
        await mkdir(join(unpackedCliDir, 'handlers'), { recursive: true })
        await writeFile(join(unpackedCliDir, 'handlers', 'skills.js'), '', 'utf8')
        await writeFile(
          join(unpackedCliDir, 'index.js'),
          [
            'const args = process.argv.slice(2)',
            "if (args[1] === 'list') console.log(JSON.stringify({ topics: [{ name: 'orca-cli' }, { name: 'computer-use' }] }))",
            "else if (args[1] === 'get') console.log(`---\\nname: ${args[2]}\\n---`)",
            'else console.log(JSON.stringify({ executed: false }))'
          ].join('\n'),
          'utf8'
        )
        await writeFile(launcherPath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o644 })

        await electronBuilderConfig.afterPack({
          appOutDir: join(root, 'linux-unpacked'),
          electronPlatformName: 'linux'
        })

        expect((await stat(launcherPath)).mode & 0o111).not.toBe(0)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  // Why: the .deb/.rpm update-recovery path keys entirely off the resources/package-type marker that
  // app-builder-lib's FpmTarget writes. If packaging silently stops shipping an fpm target, or adds
  // one the recovery path does not cover, getLinuxRootPackageType() returns null, autoInstallOnAppQuit
  // quietly goes back to true, and no unit test notices.
  describe('linux root-package update recovery contract', () => {
    // FpmTarget writes resources/package-type only for targets it supports auto-update for.
    const MARKER_TARGETS = new Set(['deb', 'rpm', 'pacman'])
    const RECOVERABLE_TARGETS = new Set(['deb', 'rpm'])
    const linuxTargets = electronBuilderConfig.linux.target.map((entry) =>
      typeof entry === 'string' ? entry : entry.target
    )

    it('still ships an AppImage plus at least one root-package target', () => {
      expect(linuxTargets).toContain('AppImage')
      expect(linuxTargets.some((target) => MARKER_TARGETS.has(target))).toBe(true)
    })

    it('ships no root-package target the recovery path cannot recover', () => {
      const unrecoverable = linuxTargets.filter(
        (target) => MARKER_TARGETS.has(target) && !RECOVERABLE_TARGETS.has(target)
      )
      expect(unrecoverable).toEqual([])
    })

    it('accepts exactly the markers electron-updater maps to a root-package updater', async () => {
      const source = await readFile(
        new URL('../../src/main/linux-update-package-type.ts', import.meta.url),
        'utf8'
      )
      for (const target of linuxTargets.filter((entry) => RECOVERABLE_TARGETS.has(entry))) {
        expect(source).toContain(`value === '${target}'`)
      }
    })
  })
})
