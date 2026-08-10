// @proves-gate-fires verify:bundled-skill-guides
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'
import { CANONICAL_GUIDE_NAMES, STUB_TOPICS } from './generate-bundled-skill-guides.mjs'

const GATE_SCRIPT = 'generate-bundled-skill-guides.mjs'
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const STALE = 'Generated bundled skill guides are stale'
// The topic list is the generator's own, so adding a guide re-shapes the fixture instead of rotting it.
const TOPIC = CANONICAL_GUIDE_NAMES[0]
const sandboxes = []

function guideSource(name, body = `Fixture body for ${name}.`) {
  return `---\nname: ${name}\ndescription: Fixture guide for ${name}.\n---\n\n# ${name}\n\n${body}\n`
}

// The generator resolves its repo root from its own location, so a copy of the real
// script in a throwaway tree runs the shipped gate rather than a re-implementation.
async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-bundled-guides-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await mkdir(path.join(root, 'skill-guides'), { recursive: true })
  await mkdir(path.join(root, 'skill-stubs'), { recursive: true })
  await copyFile(path.join(import.meta.dirname, GATE_SCRIPT), path.join(scriptDir, GATE_SCRIPT))
  // The generator parses frontmatter with `yaml`; borrow the installed copy rather than vendor one.
  await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction')
  await Promise.all([
    ...CANONICAL_GUIDE_NAMES.map((name) =>
      writeFile(path.join(root, 'skill-guides', `${name}.md`), guideSource(name))
    ),
    ...STUB_TOPICS.map((name) =>
      writeFile(
        path.join(root, 'skill-stubs', `${name}.md`),
        `# ${name}\n\nFixture discovery stub for ${name}.\n`
      )
    )
  ])

  const script = path.join(scriptDir, GATE_SCRIPT)
  const sandbox = {
    root,
    script,
    guide: (name) => path.join(root, 'skill-guides', `${name}.md`),
    projection: (name) => path.join(root, 'skills', name, 'SKILL.md'),
    embedded: path.join(root, 'src', 'cli', 'bundled-skill-guides.ts'),
    // Committed artifacts come from the generator itself, so only a planted edit can drift them.
    generate: () => assertGateAccepts({ script, args: ['--write'], cwd: root }),
    accepts: () => assertGateAccepts({ script, args: ['--check'], cwd: root }),
    rejects: (violation) =>
      assertGateRejects({ script, args: ['--check'], cwd: root, violation, expectMessage: STALE })
  }
  sandbox.generate()
  return sandbox
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verify:bundled-skill-guides rejects drift it is supposed to catch', () => {
  it('fails when a generated skill projection is edited by hand', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()
    const projection = sandbox.projection(TOPIC)

    await writeFile(projection, `${await readFile(projection, 'utf8')}\nhand-written paragraph\n`)

    expect(sandbox.rejects('an edited generated projection')).toContain(
      path.join('skills', TOPIC, 'SKILL.md')
    )
  })

  it('fails when the embedded guide module is edited by hand', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await writeFile(
      sandbox.embedded,
      (await readFile(sandbox.embedded, 'utf8')).replace('Fixture guide for', 'Reworded guide for')
    )

    expect(sandbox.rejects('an edited embedded module')).toContain(
      path.join('src', 'cli', 'bundled-skill-guides.ts')
    )
  })

  it('fails when a guide source changes and nobody regenerated', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await writeFile(
      sandbox.guide(TOPIC),
      guideSource(TOPIC, 'A paragraph the artifacts never saw.')
    )

    expect(sandbox.rejects('a guide source edited without --write')).toContain(
      path.join('src', 'cli', 'bundled-skill-guides.ts')
    )
  })

  it('fails when a generated projection is missing entirely', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()

    await rm(sandbox.projection(TOPIC))

    expect(sandbox.rejects('a deleted generated projection')).toContain(
      path.join('skills', TOPIC, 'SKILL.md')
    )
  })
})
