import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatSparseDirectoryPreview,
  getDirectoryName,
  isWebClient,
  shouldBeginWorktreeRename
} from './worktree-card-model'

describe('getDirectoryName', () => {
  it('returns the trailing segment for posix and windows paths', () => {
    expect(getDirectoryName('/home/user/project')).toBe('project')
    expect(getDirectoryName('C:\\Users\\me\\repo')).toBe('repo')
  })

  it('ignores trailing separators', () => {
    expect(getDirectoryName('/home/user/project/')).toBe('project')
    expect(getDirectoryName('C:\\Users\\me\\repo\\')).toBe('repo')
  })

  it('falls back to the original path when there is no segment', () => {
    expect(getDirectoryName('/')).toBe('/')
  })
})

describe('formatSparseDirectoryPreview', () => {
  it('joins up to four directories in full', () => {
    expect(formatSparseDirectoryPreview(['a', 'b'])).toBe('a, b')
    expect(formatSparseDirectoryPreview(['a', 'b', 'c', 'd'])).toBe('a, b, c, d')
  })

  it('summarizes the overflow past four directories', () => {
    expect(formatSparseDirectoryPreview(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a, b, c, d, +2 more')
  })
})

describe('shouldBeginWorktreeRename', () => {
  it('never begins for a null request', () => {
    expect(shouldBeginWorktreeRename(null, 'wt-1', 'all:wt-1')).toBe(false)
  })

  it('matches unscoped requests by worktree id', () => {
    expect(shouldBeginWorktreeRename({ worktreeId: 'wt-1' }, 'wt-1', 'all:wt-1')).toBe(true)
    expect(shouldBeginWorktreeRename({ worktreeId: 'wt-1' }, 'wt-2', 'all:wt-2')).toBe(false)
  })

  it('matches row-scoped requests only on the target row', () => {
    const request = { worktreeId: 'wt-1', rowKey: 'all:wt-1' }
    expect(shouldBeginWorktreeRename(request, 'wt-1', 'all:wt-1')).toBe(true)
    expect(shouldBeginWorktreeRename(request, 'wt-1', 'pinned:wt-1')).toBe(false)
  })
})

describe('isWebClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports true only when the web-client flag is set on window', () => {
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true })
    expect(isWebClient()).toBe(true)
  })

  it('reports false when the flag is absent', () => {
    vi.stubGlobal('window', {})
    expect(isWebClient()).toBe(false)
  })
})
