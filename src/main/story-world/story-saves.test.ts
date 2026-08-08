import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureStorySave, listStorySaves, pruneStorySaves, restoreStorySave } from './story-saves'

let root = ''
let userData = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'story-world-'))
  userData = mkdtempSync(join(tmpdir(), 'story-userdata-'))
  writeFileSync(join(root, 'game.js'), 'v1', 'utf8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

const save = (stamp: string, keep = 8) =>
  captureStorySave({ workspaceRoot: root, userDataPath: userData, workspaceKey: 'w', stamp, keep })

describe('captureStorySave', () => {
  it('makes a restore point that EXISTS BEFORE the first breakage', () => {
    // The whole ordering argument: a recovery-conditioned trigger could only
    // save after something broke, which is one save too late.
    save('001')
    writeFileSync(join(root, 'game.js'), 'broken', 'utf8')

    const [latest] = listStorySaves(userData, 'w')
    expect(restoreStorySave({ workspaceRoot: root, savePath: latest.path })).toBe(true)
    expect(readFileSync(join(root, 'game.js'), 'utf8')).toBe('v1')
  })

  it('lists newest first, so "go back" means the last good one', () => {
    save('001')
    save('002')
    expect(listStorySaves(userData, 'w').map((entry) => entry.id)).toEqual(['002', '001'])
  })

  it('keeps only the newest N', () => {
    for (const stamp of ['001', '002', '003', '004']) {
      save(stamp, 2)
    }
    expect(listStorySaves(userData, 'w').map((entry) => entry.id)).toEqual(['004', '003'])
  })

  it('keep=0 disables saving entirely', () => {
    // The caller must then also hide the restore button rather than leave it
    // present-and-failing.
    expect(save('001', 0)).toBeNull()
    expect(listStorySaves(userData, 'w')).toEqual([])
  })

  it('skips node_modules and dotfiles rather than copying a tree nobody needs', () => {
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8')
    writeFileSync(join(root, '.secret'), 'x', 'utf8')
    const entry = save('001')!
    expect(() => readFileSync(join(entry.path, 'node_modules', 'pkg', 'index.js'))).toThrow()
    expect(() => readFileSync(join(entry.path, '.secret'))).toThrow()
    expect(readFileSync(join(entry.path, 'game.js'), 'utf8')).toBe('v1')
  })

  it('restore is additive — newer work she did is not deleted to undo a break', () => {
    save('001')
    writeFileSync(join(root, 'drawing.txt'), 'my cat', 'utf8')
    const [latest] = listStorySaves(userData, 'w')
    restoreStorySave({ workspaceRoot: root, savePath: latest.path })
    expect(readFileSync(join(root, 'drawing.txt'), 'utf8')).toBe('my cat')
  })

  it('restoring a save that is gone reports false rather than throwing at a child', () => {
    expect(restoreStorySave({ workspaceRoot: root, savePath: join(userData, 'nope') })).toBe(false)
  })

  it('pruning an empty history is a no-op', () => {
    expect(() => pruneStorySaves(userData, 'w', 3)).not.toThrow()
  })
})
