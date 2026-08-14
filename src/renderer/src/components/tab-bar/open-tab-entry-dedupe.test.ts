import { describe, expect, it } from 'vitest'
import type { OpenTabSearchResult } from './open-tab-search'
import type { TabEntryOption } from './tab-create-entry-action'
import { dropFileEntriesCoveredByTabResults } from './open-tab-entry-dedupe'

function existingFile(relativePath: string): TabEntryOption {
  return {
    id: `existing-file:${relativePath}`,
    classification: { kind: 'existing-file', matchKind: 'fuzzy', relativePath }
  }
}

function editorTab(
  relativePath: string | null
): Extract<OpenTabSearchResult, { source: 'workspace' }> {
  return {
    source: 'workspace',
    id: `open-tab:workspace:tab-${relativePath ?? 'none'}`,
    title: 'zebra.ts',
    matchedText: null,
    worktreeId: 'wt-1',
    contentType: 'editor',
    tabId: 'tab-1',
    entityId: 'file-1',
    groupId: 'group-1',
    relativePath
  }
}

const POSIX_ROOT = '/home/dev/wt-1'
const WINDOWS_ROOT = 'C:\\Users\\dev\\wt-1'

describe('dropFileEntriesCoveredByTabResults', () => {
  it('drops the file row that duplicates an open editor tab', () => {
    const options = [existingFile('src/zebra.ts'), existingFile('src/other.ts')]

    expect(
      dropFileEntriesCoveredByTabResults(options, [editorTab('src/zebra.ts')], POSIX_ROOT).map(
        (option) => option.id
      )
    ).toEqual(['existing-file:src/other.ts'])
  })

  it('matches paths that differ only in separator style', () => {
    expect(
      dropFileEntriesCoveredByTabResults(
        [existingFile('src/zebra.ts')],
        [editorTab('src\\zebra.ts')],
        POSIX_ROOT
      )
    ).toEqual([])
  })

  it('folds case-only duplicates on a Windows worktree, not on a POSIX one', () => {
    // Same file, different case: a case-insensitive root must treat them as one.
    expect(
      dropFileEntriesCoveredByTabResults(
        [existingFile('src/zebra.ts')],
        [editorTab('src/Zebra.ts')],
        WINDOWS_ROOT
      )
    ).toEqual([])
    // A POSIX (or SSH) root keeps distinct-case names distinct.
    expect(
      dropFileEntriesCoveredByTabResults(
        [existingFile('src/zebra.ts')],
        [editorTab('src/Zebra.ts')],
        POSIX_ROOT
      )
    ).toHaveLength(1)
  })

  it('treats a null worktree path as case-sensitive', () => {
    expect(
      dropFileEntriesCoveredByTabResults(
        [existingFile('src/zebra.ts')],
        [editorTab('src/Zebra.ts')],
        null
      )
    ).toHaveLength(1)
  })

  it('matches a macOS NFD listing against an editor-recorded NFC path', () => {
    const nfc = 'src/café.ts'
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc)

    expect(
      dropFileEntriesCoveredByTabResults([existingFile(nfd)], [editorTab(nfc)], POSIX_ROOT)
    ).toEqual([])
  })

  it('keeps new-file, URL and absolute-path rows even when the path matches', () => {
    const options: TabEntryOption[] = [
      {
        id: 'new-file:src/zebra.ts',
        classification: { kind: 'new-file', relativePath: 'src/zebra.ts' }
      },
      {
        id: 'absolute-file:/tmp/wt-1/src/zebra.ts',
        classification: { kind: 'absolute-file', filePath: '/tmp/wt-1/src/zebra.ts' }
      },
      {
        id: 'host-url:https://zebra.dev',
        classification: { kind: 'host-url', url: 'https://zebra.dev' }
      }
    ]

    expect(
      dropFileEntriesCoveredByTabResults(options, [editorTab('src/zebra.ts')], POSIX_ROOT)
    ).toHaveLength(3)
  })

  it('never lets a terminal, browser or simulator result suppress a file entry', () => {
    const results: OpenTabSearchResult[] = [
      { ...editorTab(null), contentType: 'terminal' },
      {
        source: 'browser',
        id: 'open-tab:browser:page-1',
        title: 'zebra',
        matchedText: null,
        worktreeId: 'wt-1',
        contentType: 'browser',
        pageId: 'page-1',
        workspaceId: 'ws-1'
      },
      {
        source: 'simulator',
        id: 'open-tab:simulator:tab-2',
        title: 'zebra',
        matchedText: null,
        worktreeId: 'wt-1',
        contentType: 'simulator',
        tabId: 'tab-2',
        groupId: 'group-1'
      }
    ]

    expect(
      dropFileEntriesCoveredByTabResults([existingFile('src/zebra.ts')], results, POSIX_ROOT)
    ).toHaveLength(1)
  })

  it('does not let a non-editor workspace row that carries a path suppress the file', () => {
    // A diff or review tab is not the same destination as opening the file, even
    // though it references the same path.
    const diffResult = { ...editorTab('src/zebra.ts'), contentType: 'diff' as const }

    expect(
      dropFileEntriesCoveredByTabResults([existingFile('src/zebra.ts')], [diffResult], POSIX_ROOT)
    ).toHaveLength(1)
  })

  it('returns the same array when no tab result carries a path', () => {
    const options = [existingFile('src/zebra.ts')]

    expect(dropFileEntriesCoveredByTabResults(options, [], POSIX_ROOT)).toBe(options)
  })
})
