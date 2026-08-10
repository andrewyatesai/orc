// @proves-gate-fires check:exported-home-paths
//
// The gate refuses `/Users/<name>` anywhere git grep can see it, because the
// publication engine refuses to export that pattern and does not try to tell a
// real home directory from a fictional one.
//
// Sandboxed: the gate scans `git grep --untracked` from cwd, so the fixture is a
// throwaway git repo. Every path written here is under /home or a plain temp
// directory — a fixture that hardcoded /Users would trip the very gate it tests.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'
import { findHomePaths } from './check-exported-home-paths.mjs'

// The ledger's complaint about several gates is that their only coverage is
// in-process. So the two rejection arms SPAWN the real script and require a
// non-zero exit; findHomePaths is used only for the acceptance arms, where the
// assertion is "no hits" and there is no exit code to observe.
const GATE = path.join(import.meta.dirname, 'check-exported-home-paths.mjs')

const execFileAsync = promisify(execFile)
const sandboxes = []

// Assembled at runtime so this source file never itself contains the literal the
// gate forbids — otherwise adding this test would break the gate it covers.
const FORBIDDEN = `/${'Users'}/example-dev/project/fixture.json`
const SAFE = `/${'home'}/example-dev/project/fixture.json`

async function createSandbox() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-home-paths-gate-'))
  sandboxes.push(root)
  const git = (...args) =>
    execFileAsync('git', ['-c', 'user.name=orca', '-c', 'user.email=orca@example.test', ...args], {
      cwd: root
    })
  await git('init', '-q')
  await writeFile(path.join(root, 'clean.ts'), `export const fixturePath = '${SAFE}'\n`)
  await git('add', '-A')
  await git('commit', '-qm', 'fixture')
  return { root, git }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('check:exported-home-paths rejects an absolute home path', () => {
  it('accepts a fixture that uses /home rather than the forbidden root', async () => {
    const { root } = await createSandbox()
    // Positive control: without it, a fixture broken for an unrelated reason
    // would make every planted violation "fail" for free.
    expect(await findHomePaths(root)).toEqual([])
  })

  it('EXITS NON-ZERO on a committed file, naming the file that carries it', async () => {
    const { root, git } = await createSandbox()
    assertGateAccepts({ script: GATE, cwd: root })

    await writeFile(path.join(root, 'leak.ts'), `export const p = '${FORBIDDEN}'\n`)
    await git('add', '-A')
    await git('commit', '-qm', 'leak')

    const output = assertGateRejects({
      script: GATE,
      cwd: root,
      violation: 'a committed source file containing an absolute home path',
      expectMessage: 'Absolute home paths must not reach the public tree.'
    })
    // The banner alone would match any rejection, so pin the offending file too.
    expect(output).toContain('leak.ts')
    expect(output).toContain(FORBIDDEN)
  })

  it('EXITS NON-ZERO on an UNTRACKED file, so it fires before the path is staged', async () => {
    const { root } = await createSandbox()
    assertGateAccepts({ script: GATE, cwd: root })

    await writeFile(path.join(root, 'scratch.ts'), `const p = '${FORBIDDEN}'\n`)

    const output = assertGateRejects({
      script: GATE,
      cwd: root,
      violation: 'an untracked source file containing an absolute home path',
      expectMessage: 'Absolute home paths must not reach the public tree.'
    })
    expect(output).toContain('scratch.ts')
  })

  it('ignores the never-exported trees, whose contents cannot leak', async () => {
    const { root, git } = await createSandbox()
    // docs/ is on the engine's path-deny list, so a home path there is dropped
    // before any guard runs. Flagging it would be a false positive.
    await execFileAsync('mkdir', ['-p', path.join(root, 'docs')])
    await writeFile(path.join(root, 'docs', 'note.md'), `See ${FORBIDDEN}\n`)
    await git('add', '-A')
    await git('commit', '-qm', 'docs note')

    expect(await findHomePaths(root)).toEqual([])
  })

  it('respects .gitignore, so build output and node_modules stay out of the scan', async () => {
    const { root, git } = await createSandbox()
    await writeFile(path.join(root, '.gitignore'), 'out/\n')
    await execFileAsync('mkdir', ['-p', path.join(root, 'out')])
    await writeFile(path.join(root, 'out', 'bundle.js'), `const p = '${FORBIDDEN}'\n`)
    await git('add', '-A')
    await git('commit', '-qm', 'ignore out')

    expect(await findHomePaths(root)).toEqual([])
  })
})
