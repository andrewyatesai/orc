import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readGloballyUpdatableSkillLockState,
  readGloballyUpdatableSkillNames
} from './skill-update-registration'

const temporaryDirectories: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-registration-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('global skill update registration', () => {
  it('reads only updateable entries from the external updater lock', async () => {
    const homeDir = await temporaryRoot()
    await mkdir(join(homeDir, '.agents'), { recursive: true })
    await writeFile(
      join(homeDir, '.agents', '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: {
          orchestration: {
            skillFolderHash: 'hash',
            skillPath: 'skills/orchestration/SKILL.md',
            source: 'stablyai/orca'
          },
          copied: {},
          emptyHash: {
            skillFolderHash: '',
            skillPath: 'skills/empty-hash/SKILL.md',
            source: 'stablyai/orca'
          },
          emptyPath: {
            skillFolderHash: 'hash',
            skillPath: '',
            source: 'stablyai/orca'
          }
        }
      })
    )

    await expect(readGloballyUpdatableSkillNames({ homeDir, stateHome: null })).resolves.toEqual(
      new Set(['orchestration'])
    )
  })

  it('uses the XDG state lock when configured', async () => {
    const root = await temporaryRoot()
    const stateHome = join(root, 'state')
    await mkdir(join(stateHome, 'skills'), { recursive: true })
    await writeFile(
      join(stateHome, 'skills', '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: {
          'orca-cli': {
            skillFolderHash: 'hash',
            skillPath: 'skills/orca-cli/SKILL.md',
            source: 'stablyai/orca'
          }
        }
      })
    )

    await expect(readGloballyUpdatableSkillNames({ homeDir: root, stateHome })).resolves.toEqual(
      new Set(['orca-cli'])
    )
  })
})

describe('global skill lock state', () => {
  it('reports a missing lock as absent, and a readable one with its entries', async () => {
    const homeDir = await temporaryRoot()

    await expect(
      readGloballyUpdatableSkillLockState({ homeDir, stateHome: null })
    ).resolves.toEqual({ status: 'absent', locks: new Map(), detail: null })

    await mkdir(join(homeDir, '.agents'), { recursive: true })
    await writeFile(
      join(homeDir, '.agents', '.skill-lock.json'),
      JSON.stringify({
        version: 3,
        skills: {
          orchestration: {
            skillFolderHash: 'hash',
            skillPath: 'skills/orchestration/SKILL.md',
            source: 'stablyai/orca'
          }
        }
      })
    )

    await expect(
      readGloballyUpdatableSkillLockState({ homeDir, stateHome: null })
    ).resolves.toEqual({
      status: 'readable',
      locks: new Map([['orchestration', 'hash']]),
      detail: null
    })
  })

  // Why: an empty map from a lock that exists reads as "nothing is locked", which is
  // the one conclusion a failed read cannot support.
  it.each([
    ['truncated mid-write', '{"version":3,"skills":{"orchestration":'],
    ['empty', ''],
    ['not an object', '"nope"'],
    ['an older schema', JSON.stringify({ version: 2, skills: { orchestration: {} } })],
    ['missing its skill table', JSON.stringify({ version: 3 })]
  ])('reports a lock that is %s as unreadable', async (_case, contents) => {
    const homeDir = await temporaryRoot()
    await mkdir(join(homeDir, '.agents'), { recursive: true })
    await writeFile(join(homeDir, '.agents', '.skill-lock.json'), contents)

    const state = await readGloballyUpdatableSkillLockState({ homeDir, stateHome: null })

    expect(state.status).toBe('unreadable')
    expect(state.locks.size).toBe(0)
    expect(state.detail).not.toBeNull()
  })

  it('reports a lock it cannot open as unreadable', async () => {
    const homeDir = await temporaryRoot()
    // A directory where the lock belongs: refused by every platform's open(2).
    await mkdir(join(homeDir, '.agents', '.skill-lock.json'), { recursive: true })

    await expect(
      readGloballyUpdatableSkillLockState({ homeDir, stateHome: null })
    ).resolves.toMatchObject({ status: 'unreadable' })
  })
})
