import type * as NodeFsPromises from 'node:fs/promises'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTemporaryDirectory } from './bundled-skill-install.test-fixture'

// Why: the rollback is the guard against losing a package the swap displaced, and
// a rename that fails at exactly that moment cannot be provoked from the outside.
// Only the first attempt fails, so the rollback rename still gets to run.
const renameFailure = vi.hoisted(() => ({ destination: null as string | null }))

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof NodeFsPromises>()
  return {
    ...actual,
    rename: (from: string, to: string) => {
      if (renameFailure.destination !== to) {
        return actual.rename(from, to)
      }
      renameFailure.destination = null
      return Promise.reject(new Error('rename refused by the test'))
    }
  }
})

import { writeSkillPackageAtomically } from './bundled-skill-package-write'

const temporaryDirectories: string[] = []

async function skillsRoot(): Promise<string> {
  const root = await makeTemporaryDirectory('orca-skill-write-')
  temporaryDirectories.push(root)
  return root
}

afterEach(async () => {
  renameFailure.destination = null
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('atomic skill package write', () => {
  it('writes every file of a multi-file package and leaves no scratch behind', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'skills', 'demo')

    await writeSkillPackageAtomically(packagePath, [
      { path: 'SKILL.md', bytes: Buffer.from('# Demo\n'), executable: false },
      { path: 'reference/notes.md', bytes: Buffer.from('notes\n'), executable: false },
      { path: 'bin/run.sh', bytes: Buffer.from('#!/bin/sh\n'), executable: true }
    ])

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# Demo\n')
    expect(await readFile(join(packagePath, 'reference', 'notes.md'), 'utf8')).toBe('notes\n')
    expect(await readdir(join(root, 'skills'))).toEqual(['demo'])
    if (process.platform !== 'win32') {
      expect((await stat(join(packagePath, 'bin', 'run.sh'))).mode & 0o111).not.toBe(0)
      expect((await stat(join(packagePath, 'SKILL.md'))).mode & 0o111).toBe(0)
    }
  })

  it('replaces a package wholesale, dropping files the new revision no longer has', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(join(packagePath, 'reference'), { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')
    await writeFile(join(packagePath, 'reference', 'gone.md'), 'stale\n')

    await writeSkillPackageAtomically(packagePath, [
      { path: 'SKILL.md', bytes: Buffer.from('# New\n'), executable: false }
    ])

    expect(await readdir(packagePath)).toEqual(['SKILL.md'])
    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# New\n')
    expect(await readdir(root)).toEqual(['demo'])
  })

  it('leaves the previous package untouched when a later file cannot be staged', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')

    await expect(
      writeSkillPackageAtomically(packagePath, [
        { path: 'SKILL.md', bytes: Buffer.from('# New\n'), executable: false },
        // A file cannot also be a directory: staging fails after the first write.
        { path: 'SKILL.md/nested.md', bytes: Buffer.from('nested\n'), executable: false }
      ])
    ).rejects.toThrow()

    expect(await readdir(packagePath)).toEqual(['SKILL.md'])
    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# Old\n')
    expect(await readdir(root)).toEqual(['demo'])
  })

  it('restores the displaced package when the swap itself fails', async () => {
    const root = await skillsRoot()
    const packagePath = join(root, 'demo')
    await mkdir(join(packagePath, 'reference'), { recursive: true })
    await writeFile(join(packagePath, 'SKILL.md'), '# Old\n')
    await writeFile(join(packagePath, 'reference', 'notes.md'), 'old notes\n')
    renameFailure.destination = packagePath

    await expect(
      writeSkillPackageAtomically(packagePath, [
        { path: 'SKILL.md', bytes: Buffer.from('# New\n'), executable: false }
      ])
    ).rejects.toThrow('rename refused by the test')

    expect(await readFile(join(packagePath, 'SKILL.md'), 'utf8')).toBe('# Old\n')
    expect(await readFile(join(packagePath, 'reference', 'notes.md'), 'utf8')).toBe('old notes\n')
    expect(await readdir(root)).toEqual(['demo'])
  })
})
