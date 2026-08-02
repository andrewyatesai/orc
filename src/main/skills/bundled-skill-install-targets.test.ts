import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalAgentSkillsRootPath,
  detectBundledSkillInstallRoots
} from './bundled-skill-install-targets'
import { makeTemporaryDirectory } from './bundled-skill-install.test-fixture'

const temporaryDirectories: string[] = []

async function homeWith(configDirectories: readonly string[]): Promise<string> {
  const homeDir = await makeTemporaryDirectory('orca-skill-targets-')
  temporaryDirectories.push(homeDir)
  for (const directory of configDirectories) {
    await mkdir(join(homeDir, ...directory.split('/')), { recursive: true })
  }
  return homeDir
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('bundled skill install targets', () => {
  it('detects only the agents whose config directory already exists', async () => {
    const homeDir = await homeWith(['.claude', '.config/opencode'])

    const roots = await detectBundledSkillInstallRoots({ homeDir })

    expect(roots.map((root) => root.id)).toEqual(['home-claude', 'home-opencode'])
    expect(roots.map((root) => root.path)).toEqual([
      join(homeDir, '.claude', 'skills'),
      join(homeDir, '.config', 'opencode', 'skills')
    ])
    // Detection is a read: an agent the user does not have stays absent.
    expect(await readdir(homeDir)).toEqual(['.claude', '.config'])
  })

  it('puts the cross-agent root first so provider aliases resolve to a handled placement', async () => {
    const roots = await detectBundledSkillInstallRoots({
      homeDir: await homeWith(['.codex', '.agents', '.claude'])
    })

    expect(roots.map((root) => root.id)).toEqual(['home-agents', 'home-codex', 'home-claude'])
  })

  it('ignores a config path that is not a directory, and reports no target at all', async () => {
    const homeDir = await homeWith([])
    await writeFile(join(homeDir, '.codex'), 'not a directory')

    expect(await detectBundledSkillInstallRoots({ homeDir })).toEqual([])
    expect(canonicalAgentSkillsRootPath(homeDir)).toBe(join(homeDir, '.agents', 'skills'))
  })
})
