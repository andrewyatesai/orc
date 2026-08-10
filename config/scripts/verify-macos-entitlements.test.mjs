// @proves-gate-fires verify:macos-entitlements
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_SCRIPT = 'verify-macos-entitlements.mjs'
// package.json runs the gate with no arguments, so its two defaults are the whole gated
// set; the gate resolves them against `<script>/../..`, which is the sandbox root here.
const APP_PLIST = 'resources/build/entitlements.mac.plist'
const COMPUTER_USE_PLIST = 'resources/build/entitlements.computer-use.mac.plist'

const APP_GRANTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.device.camera'
]
const NESTED_KEY = 'com.apple.security.temporary-exception.mach-lookup.global-name'
const HELPER_NAMES = ['com.alabsystems.orca.helper', 'com.alabsystems.orca.updater']

const sandboxes = []

function plist(body) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    body,
    '</dict>',
    '</plist>',
    ''
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function grant(key) {
  return `\t<key>${key}</key>\n\t<true/>`
}

/**
 * A commented-out grant plus a nested dict: the clean fixture only passes if the gate
 * skips comments and scopes keys per dict instead of flat-scanning the file.
 */
function appPlistBody({ grants = APP_GRANTS, helpers = HELPER_NAMES, trailing = '' } = {}) {
  return [
    `\t<!-- <key>${APP_GRANTS[0]}</key><true/> was granted twice before the signing audit -->`,
    ...grants.map(grant),
    `\t<key>${NESTED_KEY}</key>`,
    '\t<dict>',
    ...helpers.map((name) => `\t\t<key>${name}</key>\n\t\t<true/>`),
    '\t</dict>',
    trailing
  ]
    .filter(Boolean)
    .join('\n')
}

async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-entitlements-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await mkdir(path.join(root, 'resources', 'build'), { recursive: true })
  await copyFile(path.join(import.meta.dirname, GATE_SCRIPT), path.join(scriptDir, GATE_SCRIPT))

  const sandbox = {
    root,
    script: path.join(scriptDir, GATE_SCRIPT),
    writeAppPlist: (body) => writeFile(path.join(root, ...APP_PLIST.split('/')), plist(body)),
    writeComputerUsePlist: (body) =>
      writeFile(path.join(root, ...COMPUTER_USE_PLIST.split('/')), plist(body)),
    accepts: () => assertGateAccepts({ script: sandbox.script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: sandbox.script, cwd: root, violation, expectMessage })
  }
  await sandbox.writeAppPlist(appPlistBody())
  await sandbox.writeComputerUsePlist(
    '\t<key>com.apple.security.device.audio-input</key>\n\t<true/>'
  )
  return sandbox
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verify:macos-entitlements rejects the duplicate grants codesign refuses to sign', () => {
  it('fails when an entitlement is granted twice in the app plist', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.writeAppPlist(appPlistBody({ grants: [...APP_GRANTS, APP_GRANTS[0]] }))

    const output = sandbox.rejects(
      'a second grant of an entitlement the plist already declares',
      `- ${APP_GRANTS[0]} first appears on line`
    )
    expect(output).toContain(`${APP_PLIST}: duplicate plist dict keys found`)
  })

  it('fails when the duplicate hides inside a nested dict', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.writeAppPlist(appPlistBody({ helpers: [...HELPER_NAMES, HELPER_NAMES[0]] }))

    sandbox.rejects(
      'a duplicate key one dict below the entitlement root',
      `- ${HELPER_NAMES[0]} first appears on line`
    )
  })

  it('fails when the duplicate is spelled with XML character entities', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    const escaped = APP_GRANTS[1].replaceAll('.', '&#46;')
    await sandbox.writeAppPlist(appPlistBody({ trailing: `\t<key>${escaped}</key>\n\t<true/>` }))

    sandbox.rejects(
      'a duplicate grant escaped so a literal-text scan would miss it',
      `- ${APP_GRANTS[1]} first appears on line`
    )
  })

  it('fails on the computer-use plist, not only the first path it reads', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.writeComputerUsePlist(
      `${grant('com.apple.security.device.audio-input')}\n${grant('com.apple.security.device.audio-input')}`
    )

    const output = sandbox.rejects(
      'a duplicate grant in the second default plist',
      `${COMPUTER_USE_PLIST}: duplicate plist dict keys found`
    )
    // The clean first plist still reports OK, so the failure is the second file's alone.
    expect(output).toContain(`${APP_PLIST}: OK`)
  })
})
