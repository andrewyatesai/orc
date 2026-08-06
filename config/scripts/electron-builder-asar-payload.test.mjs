import { createRequire } from 'node:module'
import { minimatch } from 'minimatch'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')

describe('app.asar payload exclusions', () => {
  // Why: an exclude list that reads correctly can still fail to match — `!tools/**`
  // never matches the `tools` directory entry itself. Match the real paths that
  // leaked into a packaged app.asar (748MB vs upstream 120MB) against the patterns
  // electron-builder actually evaluates, so a typo cannot pass review again.
  it('excludes every dev-only and build-only tree that leaked into app.asar', () => {
    const negations = electronBuilderConfig.files
      .filter((pattern) => pattern.startsWith('!'))
      .map((pattern) => pattern.slice(1))
    const excluded = (candidate) =>
      negations.some((pattern) => minimatch(candidate, pattern, { dot: true }))

    for (const leaked of [
      'out/electron-dev',
      'out/electron-dev/8f21c0/Orca.app/Contents/MacOS/Electron',
      'out/.orca-dev-web-stash-GwvG53',
      'out/.orca-dev-web-stash-GwvG53/assets/index.js',
      'tools',
      'tools/terminal-bench/package.json',
      'build-plugins',
      'build-plugins/index.ts',
      'test-results',
      'publish',
      'publish/config.sh',
      '.gitleaks.toml',
      '.gitmodules',
      '.lintstagedrc.mjs',
      'FEATURE_WALKTHROUGH.md'
    ]) {
      expect(excluded(leaked), `${leaked} must not ship in app.asar`).toBe(true)
    }

    // Why: over-broad globs are the other failure mode — `!out{,/**/*}` would also
    // pass the loop above while deleting the entire runtime.
    for (const shipped of [
      'out/main/index.js',
      'out/renderer/index.html',
      'out/shared/constants.js',
      'out/cli/index.js',
      'out/web/index.html',
      'out/relay/relay.js',
      'out/preload/index.js',
      'package.json'
    ]) {
      expect(excluded(shipped), `${shipped} must still ship in app.asar`).toBe(false)
    }
  })
})
