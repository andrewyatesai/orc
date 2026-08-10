// @proves-gate-fires verify:computer-native
import { spawnSync } from 'node:child_process'
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_SCRIPT = 'verify-computer-native.mjs'
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
// The gate resolves its repo root from its own location, so the shipped script copied into
// config/scripts of a temp tree reads these files instead of the ones in the real checkout.
const PROVIDERS = {
  linux: 'native/computer-use-linux/runtime.py',
  windows: 'native/computer-use-windows/runtime.ps1',
  macos: 'native/computer-use-macos/Sources/OrcaComputerUseMacOS/main.swift'
}
const HELPER_APP = path.join(
  'native',
  'computer-use-macos',
  '.build',
  'release',
  'Orca Computer Use.app'
)
const HELPER_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Orca Computer Use</string>
<key>CFBundleIdentifier</key><string>test.orca.computer-native-gate</string>
<key>CFBundleName</key><string>Orca Computer Use</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
`
const ORIGINAL_PATH = process.env.PATH ?? ''
const sandboxes = []

async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-computer-native-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await copyFile(path.join(import.meta.dirname, GATE_SCRIPT), path.join(scriptDir, GATE_SCRIPT))
  // The real provider sources are the fixture: the positive control then asserts something
  // true about shipped code, and each plant is a regression a reviewer could actually make.
  for (const relative of Object.values(PROVIDERS)) {
    const destination = path.join(root, relative)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.join(REPO_ROOT, relative), destination)
  }
  await createHelperApp(root)
  process.env.PATH = `${await createSwiftShim(root)}${path.delimiter}${ORIGINAL_PATH}`

  const script = path.join(scriptDir, GATE_SCRIPT)
  return {
    root,
    accepts: () => assertGateAccepts({ script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script, cwd: root, violation, expectMessage }),
    plant: (provider, anchor, replacement) =>
      plant(path.join(root, PROVIDERS[provider]), anchor, replacement)
  }
}

/** Replace the first occurrence, and fail loudly when the anchor has drifted out of the file. */
async function plant(file, anchor, replacement) {
  const source = await readFile(file, 'utf8')
  expect(source.includes(anchor), `plant anchor missing from ${file}: ${anchor}`).toBe(true)
  await writeFile(file, source.replace(anchor, replacement))
}

// `verifyMacOSHelperApp` wants a bundle codesign accepts; ad-hoc signing needs no keychain.
async function createHelperApp(root) {
  const app = path.join(root, HELPER_APP)
  await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(path.join(app, 'Contents', 'MacOS', 'Orca Computer Use'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755
  })
  await writeFile(path.join(app, 'Contents', 'Info.plist'), HELPER_INFO_PLIST)
  if (process.platform !== 'darwin') {
    return
  }
  const signed = spawnSync('codesign', ['--force', '--sign', '-', app], { encoding: 'utf8' })
  if (signed.status !== 0) {
    throw new Error(
      `Could not ad-hoc sign the fixture helper app: ${signed.stderr ?? signed.error?.message}`
    )
  }
}

/**
 * `swift test` needs the real SwiftPM package and an XCTest-capable toolchain, which a temp
 * tree does not have and a Command-Line-Tools-only Mac cannot provide at all. The stub stands
 * in for that one check and refuses every invocation except the gate's own, so a gate that
 * stopped running `swift test --package-path native/computer-use-macos` fails the positive
 * control instead of passing on a stub that says yes to anything.
 */
async function createSwiftShim(root) {
  const shim = path.join(root, 'swift-toolchain-shim')
  await mkdir(shim, { recursive: true })
  await writeFile(
    path.join(shim, 'swift'),
    `#!/bin/sh
if [ "$1" = "test" ] && [ "$2" = "--package-path" ] && [ "$3" = "native/computer-use-macos" ]; then
  echo "swift-test-invoked"
  exit 0
fi
echo "unexpected swift invocation: $*" >&2
exit 1
`,
    { mode: 0o755 }
  )
  return shim
}

afterEach(async () => {
  process.env.PATH = ORIGINAL_PATH
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verify:computer-native rejects native provider regressions it is supposed to catch', () => {
  it('fails when the Linux provider stops parsing as Python', async () => {
    const sandbox = await createSandbox()
    expect(sandbox.accepts()).toContain('native provider argument guardrails')

    await appendFile(
      path.join(sandbox.root, PROVIDERS.linux),
      '\n\ndef orca_gate_negative_probe(:\n    pass\n'
    )

    sandbox.rejects('a syntax error in the Linux provider', 'orca_gate_negative_probe')
  })

  it('fails when a Linux restore call site drops the selected window', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.plant('linux', 'restore_window(app, window)', 'restore_window(app)')

    sandbox.rejects(
      'a restore call site that falls back to the whole application',
      'Linux restore call sites must pass the selected window target'
    )
  })

  it('fails when macOS element identity folds in mutable text', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.plant(
      'macos',
      '        node.roleDescription ?? "",',
      '        node.value ?? "",\n        node.roleDescription ?? "",'
    )

    sandbox.rejects(
      'a snapshot value folded into the macOS element signature',
      'macOS element identity must not include mutable text value or placeholder content'
    )
  })

  it('fails when macOS looks up a cached element before pruning the cache', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.plant(
      'macos',
      '        pruneSnapshotCache()\n        let cached = try cachedSnapshot(params: params)',
      '        let cached = try cachedSnapshot(params: params)\n        pruneSnapshotCache()'
    )

    sandbox.rejects(
      'a cached-element lookup reordered ahead of the prune',
      'macOS cached snapshots must be pruned before cached element lookup'
    )
  })

  it('fails when a Windows screenshot cap failure stops being structured', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.plant('windows', 'error = [pscustomobject]@{', 'error = @{')

    sandbox.rejects(
      'an untyped Windows screenshot cap error payload',
      'Windows screenshot cap failures must return a structured error object'
    )
  })
})
