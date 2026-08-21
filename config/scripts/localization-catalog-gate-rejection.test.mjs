// @proves-gate-fires verify:localization-catalog
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_MODULE = 'verify-localization-catalog.mjs'
const LOCALES_DIR = path.join('src', 'renderer', 'src', 'i18n', 'locales')
const RENDERER_DIR = path.join('src', 'renderer', 'src', 'components')
const MAIN_DIR = path.join('src', 'main')
const EN_CATALOG = {
  sandbox: { title: 'Sandbox', greeting: 'Hello {{name}}', mainNotice: 'Main notice' }
}
const ES_CATALOG = {
  sandbox: { title: 'Caja de arena', greeting: 'Hola {{name}}', mainNotice: 'Aviso principal' }
}
const PANEL_SOURCE = `export function SandboxPanel() {
  const heading = t('sandbox.title', 'Sandbox')
  const hello = t('sandbox.greeting', 'Hello {{name}}')
  return [heading, hello]
}
`
const MAIN_SOURCE = `export const notice = translateMain('sandbox.mainNotice', 'Main notice')
`
const sandboxes = []

// The gate imports typescript-api, and that alias exists only in the installed root,
// so the sandbox borrows it rather than pretending the parser is available.
function installedModulesRoot() {
  let dir = import.meta.dirname
  for (;;) {
    const candidate = path.join(dir, 'node_modules')
    if (existsSync(path.join(candidate, 'typescript-api'))) {
      return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error('Could not find an installed node_modules containing typescript-api')
    }
    dir = parent
  }
}

function writeJson(filePath, value) {
  return writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

// The gate imports the locale-translation-policy chain, whose modules resolve each other and a
// runtime JSON relative to their own directory, so the sandbox needs the whole locale-* closure
// beside the gate — not the single gate file.
async function copyGateModules(scriptDir) {
  const entries = await readdir(import.meta.dirname)
  const modules = entries.filter(
    (name) =>
      name === GATE_MODULE ||
      ((name.startsWith('locale-') || name === 'locale.mjs') &&
        (name.endsWith('.json') || (name.endsWith('.mjs') && !name.endsWith('.test.mjs'))))
  )
  await Promise.all(
    modules.map((name) =>
      copyFile(path.join(import.meta.dirname, name), path.join(scriptDir, name))
    )
  )
}

// A miniature app — one catalog, one translation, and both source roots the gate walks —
// wired so the real gate passes, leaving the planted violation as the only difference.
async function createSandbox() {
  // realpath: the gate only runs main() when argv[1] matches import.meta.url, so on macOS
  // a /var temp dir against its /private/var realpath would make the copy a silent no-op.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-localization-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await mkdir(path.join(root, LOCALES_DIR), { recursive: true })
  await mkdir(path.join(root, RENDERER_DIR), { recursive: true })
  await mkdir(path.join(root, MAIN_DIR), { recursive: true })
  await symlink(installedModulesRoot(), path.join(root, 'node_modules'), 'dir')
  await copyGateModules(scriptDir)

  await writeJson(path.join(root, LOCALES_DIR, 'en.json'), structuredClone(EN_CATALOG))
  await writeJson(path.join(root, LOCALES_DIR, 'es.json'), structuredClone(ES_CATALOG))
  await writeFile(path.join(root, RENDERER_DIR, 'SandboxPanel.tsx'), PANEL_SOURCE, 'utf8')
  await writeFile(path.join(root, MAIN_DIR, 'sandbox-notice.ts'), MAIN_SOURCE, 'utf8')

  const script = path.join(scriptDir, GATE_MODULE)
  return {
    // No flags and cwd at the repo root, exactly how package.json runs the gate.
    accepts: () => assertGateAccepts({ script, args: [], cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script, args: [], cwd: root, violation, expectMessage }),
    addSource: (fileName, source) =>
      writeFile(path.join(root, RENDERER_DIR, fileName), source, 'utf8'),
    writeCatalog: (fileName, catalog) => writeJson(path.join(root, LOCALES_DIR, fileName), catalog)
  }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verify:localization-catalog rejects catalog drift it is supposed to catch', () => {
  it('fails when a user-facing string has no catalog entry', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.addSource(
      'SandboxBadge.tsx',
      "export const badge = () => t('sandbox.badge.label')\n"
    )

    sandbox.rejects(
      'a translated string with no catalog entry',
      'Localization keys are missing from src/renderer/src/i18n/locales/en.json.'
    )
  })

  it('names the call site when an in-use catalog entry is deleted', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.writeCatalog('en.json', {
      sandbox: { title: 'Sandbox', mainNotice: 'Main notice' }
    })

    sandbox.rejects('a deleted in-use catalog entry', 'SandboxPanel.tsx:3:19 sandbox.greeting')
  })

  it('fails when a main-process key loses its catalog entry', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.writeCatalog('en.json', {
      sandbox: { title: 'Sandbox', greeting: 'Hello {{name}}' }
    })

    sandbox.rejects(
      'a deleted main-process catalog entry',
      'src/main/sandbox-notice.ts:1:37 sandbox.mainNotice'
    )
  })

  it('fails when one key is used with two different placeholder sets', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.addSource(
      'SandboxGreeting.tsx',
      "export const greeting = () => t('sandbox.greeting', 'Hi {{firstName}}')\n"
    )

    sandbox.rejects(
      'the same key used with mismatched interpolation placeholders',
      'Localization keys are used with inconsistent interpolation placeholders.'
    )
  })

  it('fails when a translated locale drops a key English still has', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.writeCatalog('es.json', {
      sandbox: { title: 'Caja de arena', mainNotice: 'Aviso principal' }
    })

    sandbox.rejects('a locale catalog missing an English key', 'missing: sandbox.greeting')
  })

  it('fails when a translated locale carries a key English does not', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.writeCatalog('es.json', {
      sandbox: { ...ES_CATALOG.sandbox, retired: 'Texto abandonado' }
    })

    sandbox.rejects('a locale catalog with a stale extra key', 'extra: sandbox.retired')
  })

  it('fails when a translation rewrites an interpolation variable', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.writeCatalog('es.json', {
      sandbox: { ...ES_CATALOG.sandbox, greeting: 'Hola {{nombre}}' }
    })

    sandbox.rejects(
      'a translation whose placeholder was renamed',
      'interpolation mismatch: sandbox.greeting'
    )
  })

  // Why: #12113 — a translated generic term the repair policy would rewrite back to English must
  // fail the gate, not slip through parity. 'Claude Agent Teams' is a pinned product name, so
  // repair reverts the whole value and destroys the translated 'Agente'.
  it('fails when a translated generic term would be rewritten to English', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.addSource(
      'SandboxTeams.tsx',
      "export const teams = () => t('sandbox.teams', 'Claude Agent Teams')\n"
    )
    await sandbox.writeCatalog('en.json', {
      sandbox: { ...EN_CATALOG.sandbox, teams: 'Claude Agent Teams' }
    })
    await sandbox.writeCatalog('es.json', {
      sandbox: { ...ES_CATALOG.sandbox, teams: 'Equipos de Agente' }
    })

    sandbox.rejects(
      'a translated generic term the repair policy would revert to English',
      'sandbox.teams: Agente -> English'
    )
  })
})
