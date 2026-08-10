// @proves-gate-fires check:cli-main-entries
//
// The gate says: every runtime `src/main/**` module the CLI imports must be an
// electron-vite entry, or `pnpm dev` deletes it out from under the built CLI.
// Both sides of that invariant can drift — a NEW import, or a DELETED config
// entry — so both are planted here.
//
// Runs against a sandbox rather than the real tree. The gate derives its repo
// root from its own location (`import.meta.dirname/../..`), so copying the
// script into `<sandbox>/config/scripts/` reparents everything it reads.
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE = 'check-cli-main-entry-coverage.mjs'
const EXPECT_MESSAGE =
  'check-cli-main-entry-coverage: the CLI imports src/main modules that electron-vite does not emit.'
const sandboxes = []

/** Config declaring exactly the one entry the fixture CLI imports. */
function viteConfig(entries) {
  const lines = entries.map((spec) => `        '${spec}': resolve('src/main/${spec}.ts'),`)
  return `import { resolve } from 'path'\nexport default {\n  main: { build: { rollupOptions: { input: {\n${lines.join('\n')}\n  } } } }\n}\n`
}

async function createSandbox({ imports, entries }) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-cli-main-entry-gate-'))
  sandboxes.push(root)
  await mkdir(path.join(root, 'config', 'scripts'), { recursive: true })
  await mkdir(path.join(root, 'src', 'cli', 'runtime'), { recursive: true })
  // walk() readdirs both CLI_ROOTS, so src/shared must exist even when empty.
  await mkdir(path.join(root, 'src', 'shared'), { recursive: true })
  await copyFile(path.join(import.meta.dirname, GATE), path.join(root, 'config', 'scripts', GATE))

  const body = imports
    .map((spec, index) => `import { thing${index} } from '../../main/${spec}'`)
    .join('\n')
  await writeFile(
    path.join(root, 'src', 'cli', 'runtime', 'sessions.ts'),
    `${body}\nexport const used = [${imports.map((_, i) => `thing${i}`).join(', ')}]\n`
  )
  await writeFile(path.join(root, 'electron.vite.config.ts'), viteConfig(entries))
  return { root, script: path.join(root, 'config', 'scripts', GATE) }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('check:cli-main-entries rejects a drifted entry map', () => {
  it('accepts a fixture where every imported main module is declared', async () => {
    const { root, script } = await createSandbox({
      imports: ['daemon/client'],
      entries: ['daemon/client']
    })
    assertGateAccepts({ script, cwd: root })
  })

  it('rejects a NEW cli import with no electron-vite entry', async () => {
    const { root, script } = await createSandbox({
      imports: ['daemon/client', 'win32-utils'],
      entries: ['daemon/client']
    })
    assertGateRejects({
      script,
      cwd: root,
      violation: "src/cli imports '../../main/win32-utils' but the config declares no entry for it",
      expectMessage: EXPECT_MESSAGE
    })
  })

  it('rejects a DELETED entry while the cli still imports it', async () => {
    const { root, script } = await createSandbox({
      imports: ['daemon/client'],
      entries: []
    })
    assertGateRejects({
      script,
      cwd: root,
      violation: "the 'daemon/client' entry was removed from electron.vite.config.ts",
      expectMessage: EXPECT_MESSAGE
    })
  })

  it('ignores type-only imports, which tsc erases before they can become a require', async () => {
    const { root, script } = await createSandbox({
      imports: ['daemon/client'],
      entries: ['daemon/client']
    })
    // Undeclared, but `import type` never reaches runtime — flagging it would
    // push a dead module into the bundle.
    await writeFile(
      path.join(root, 'src', 'cli', 'runtime', 'types.ts'),
      "import type { Shape } from '../../main/never-emitted'\nexport type Alias = Shape\n"
    )
    assertGateAccepts({ script, cwd: root })
  })
})
