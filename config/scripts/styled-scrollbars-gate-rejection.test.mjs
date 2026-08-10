// @proves-gate-fires check:styled-scrollbars
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_ENTRY = 'check-styled-scrollbars.mjs'
const GATE_RULE = path.join('styled-scrollbars', 'styled-scrollbar-jsx-check.mjs')
const RENDERER_SOURCE = path.join('src', 'renderer', 'src')
const REPO_NODE_MODULES = path.resolve(import.meta.dirname, '..', '..', 'node_modules')

// Line/column are asserted, so every fixture keeps its scroll container on line 3.
const CLEAN_FIXTURE = {
  'components/scroll-panel.tsx': `export function ScrollPanel({ children }) {
  return (
    <div className="max-h-[280px] overflow-y-auto p-1 scrollbar-sleek">{children}</div>
  )
}
`,
  'components/inline-scroll-surface.tsx': `export function InlineScrollSurface() {
  return (
    <div className="scrollbar-editor rounded" style={{ overflowY: 'auto', maxHeight: 200 }}>
      inline
    </div>
  )
}
`,
  'components/variant-scroll-list.tsx': `export function VariantScrollList() {
  return (
    <ul className="md:overflow-y-auto md:scrollbar-sleek">
      <li>row</li>
    </ul>
  )
}
`,
  // Horizontal-only overflow is deliberately out of scope; keep it clean-side.
  'components/horizontal-filmstrip.tsx': `export function HorizontalFilmstrip() {
  return (
    <div className="flex overflow-x-auto gap-2">
      <span>frame</span>
    </div>
  )
}
`
}

const sandboxes = []

async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-styled-scrollbars-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(path.join(scriptDir, 'styled-scrollbars'), { recursive: true })
  await Promise.all(
    [GATE_ENTRY, GATE_RULE].map((name) =>
      copyFile(path.join(import.meta.dirname, name), path.join(scriptDir, name))
    )
  )
  // The rule parses TSX with typescript-api, so the sandbox needs a resolvable install.
  await symlink(
    await realpath(REPO_NODE_MODULES),
    path.join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )

  const sandbox = {
    root,
    script: path.join(scriptDir, GATE_ENTRY),
    write: async (relativePath, source) => {
      const target = path.join(root, RENDERER_SOURCE, ...relativePath.split('/'))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, source)
    },
    accepts: () => assertGateAccepts({ script: sandbox.script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: sandbox.script, cwd: root, violation, expectMessage })
  }
  for (const [relativePath, source] of Object.entries(CLEAN_FIXTURE)) {
    await sandbox.write(relativePath, source)
  }
  return sandbox
}

afterEach(async () => {
  for (const root of sandboxes.splice(0)) {
    // Unlink the node_modules symlink first so no recursive walk can reach the real install.
    await rm(path.join(root, 'node_modules'), { force: true })
    await rm(root, { recursive: true, force: true })
  }
})

describe('check:styled-scrollbars rejects the scroll containers it is supposed to catch', () => {
  it('fails when a scroll container drops its scrollbar class', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.write(
      'components/scroll-panel.tsx',
      `export function ScrollPanel({ children }) {
  return (
    <div className="max-h-[280px] overflow-y-auto p-1">{children}</div>
  )
}
`
    )

    sandbox.rejects(
      'a vertical scroll container with no Orca scrollbar class',
      'src/renderer/src/components/scroll-panel.tsx:3:20 overflow-y-auto'
    )
  })

  it('fails when an inline overflow style carries no className at all', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.write(
      'components/probe-scroll-region.tsx',
      `export function ProbeScrollRegion() {
  return (
    <div style={{ overflowY: 'auto', maxHeight: 200 }}>probe</div>
  )
}
`
    )

    sandbox.rejects(
      'an inline overflowY:auto element with no scrollbar class',
      'src/renderer/src/components/probe-scroll-region.tsx:3:19 inline vertical scroll'
    )
  })

  it('fails when the scrollbar class sits at a different variant than the overflow class', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.write(
      'components/variant-scroll-list.tsx',
      `export function VariantScrollList() {
  return (
    <ul className="md:overflow-y-auto lg:scrollbar-sleek">
      <li>row</li>
    </ul>
  )
}
`
    )

    sandbox.rejects(
      'a scrollbar class that only applies at a variant the overflow does not',
      'src/renderer/src/components/variant-scroll-list.tsx:3:19 overflow-y-auto'
    )
  })

  it('fails when only a conditional branch supplies the scrollbar class for inline overflow', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await sandbox.write(
      'components/conditional-scroll-shell.tsx',
      `export function ConditionalScrollShell({ active }) {
  return (
    <div className={active ? 'scrollbar-sleek' : 'p-0'} style={{ overflow: 'hidden auto' }}>
      shell
    </div>
  )
}
`
    )

    sandbox.rejects(
      'an inline overflow whose scrollbar class renders on only one branch',
      'src/renderer/src/components/conditional-scroll-shell.tsx:3:66 inline vertical scroll'
    )
  })
})
