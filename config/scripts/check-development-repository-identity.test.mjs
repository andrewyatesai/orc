// @proves-gate-fires check:development-repository-identity
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

const GATE_MODULES = ['check-development-repository-identity.mjs', 'release-repository.mjs']
const PUBLIC_OWNER = 'alabsystems'
// Fictional: the gate derives the private development owner from the sandbox's own
// remote, so no real org name has to be spelled out in a file that ships publicly.
const DEV_OWNER = 'fixture-dev-org'
const OK_MESSAGE = 'ok — development and public dependency repository names are canonical.'
const sandboxes = []
let ambientOwner

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.name=orca', '-c', 'user.email=orca@example.test', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

// A repo whose only remote names `owner`, holding docs that use canonical names only.
async function createSandbox(owner) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-repo-identity-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  await mkdir(scriptDir, { recursive: true })
  await mkdir(path.join(root, 'docs'), { recursive: true })
  await Promise.all(
    GATE_MODULES.map((name) =>
      copyFile(path.join(import.meta.dirname, name), path.join(scriptDir, name))
    )
  )
  // Near-misses on purpose: both share a retired name's prefix, so a clean fixture
  // also proves the gate's word boundary rather than an accidentally inert pattern.
  await writeFile(
    path.join(root, 'docs', 'repository.md'),
    `development ${DEV_OWNER}/orca-alab\npublic ${PUBLIC_OWNER}/orca-alab\nengine ${DEV_OWNER}/aterm-engine\n`
  )
  git(root, 'init', '--quiet')
  git(root, 'remote', 'add', 'origin', `https://github.com/${owner}/orca-alab.git`)

  const sandbox = {
    root,
    script: path.join(scriptDir, GATE_MODULES[0]),
    // git grep only reads tracked paths, so a planted file is invisible until it is added.
    plant: async (file, contents) => {
      await writeFile(path.join(root, file), contents)
      git(root, 'add', '-A')
    },
    accepts: () => assertGateAccepts({ script: sandbox.script, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script: sandbox.script, cwd: root, violation, expectMessage })
  }
  git(root, 'add', '-A')
  return sandbox
}

beforeEach(() => {
  // The gate prefers this over the remote, and the helper hands the child our env:
  // an ambient value would silently scope every assertion below to the wrong owner.
  ambientOwner = process.env.ORCA_DEVELOPMENT_OWNER
  delete process.env.ORCA_DEVELOPMENT_OWNER
})

afterEach(async () => {
  if (ambientOwner === undefined) {
    delete process.env.ORCA_DEVELOPMENT_OWNER
  } else {
    process.env.ORCA_DEVELOPMENT_OWNER = ambientOwner
  }
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:development-repository-identity rejects retired repository names', () => {
  it('fails when a tracked file still points at the retired orc repository', async () => {
    const sandbox = await createSandbox(DEV_OWNER)
    // Not merely exit 0: a skipped run would also be 0 and cover nothing.
    expect(sandbox.accepts()).toContain(OK_MESSAGE)

    await sandbox.plant('docs/migration.md', `clone https://github.com/${DEV_OWNER}/orc\n`)

    sandbox.rejects('a retired development repository name', `retired reference ${DEV_OWNER}/orc`)
  })

  it('fails when a dependency is still sourced from the retired aterm repository', async () => {
    const sandbox = await createSandbox(DEV_OWNER)
    expect(sandbox.accepts()).toContain(OK_MESSAGE)

    await sandbox.plant('docs/engine.md', `submodule ${DEV_OWNER}/aterm.git\n`)

    sandbox.rejects('a retired dependency repository name', `retired reference ${DEV_OWNER}/aterm`)
  })

  it('reports the offending file and line, not just a bare exit code', async () => {
    const sandbox = await createSandbox(DEV_OWNER)
    expect(sandbox.accepts()).toContain(OK_MESSAGE)

    await sandbox.plant('docs/migration.md', `keep\n${DEV_OWNER}/orc\n`)

    sandbox.rejects('a retired name on a known line', 'docs/migration.md:2:')
  })

  it('scopes itself to the development owner: a public-only checkout is skipped by design', async () => {
    const sandbox = await createSandbox(PUBLIC_OWNER)
    await sandbox.plant('docs/migration.md', `clone https://github.com/${DEV_OWNER}/orc\n`)

    // The remote names nobody but the public owner, so the gate has no owner to scope to.
    expect(sandbox.accepts()).toContain('skipped — no development remote')

    process.env.ORCA_DEVELOPMENT_OWNER = DEV_OWNER
    sandbox.rejects(
      'a retired name in a checkout whose owner is configured instead of derived',
      `retired reference ${DEV_OWNER}/orc`
    )
  })
})
