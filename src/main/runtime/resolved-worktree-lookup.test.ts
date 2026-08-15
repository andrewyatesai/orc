import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { OrcaRuntimeService } from './orca-runtime'
import {
  createIncrementalResolvedWorktreeLookup,
  runtimeWorktreeLookupKey
} from './resolved-worktree-lookup'

const REPO_ID = 'repo-1'
const FOLDER_PATH = '/tmp/folder-project'
const ROOT_ID = `${REPO_ID}::${FOLDER_PATH}`

const REPO = {
  id: REPO_ID,
  path: FOLDER_PATH,
  displayName: 'folder-project',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'folder'
} as const

describe('createIncrementalResolvedWorktreeLookup', () => {
  it('returns the first indexed worktree when normalized identities collide', () => {
    const first = { id: `${ROOT_ID}/dup/`, tag: 'first' }
    const equivalent = { id: `${ROOT_ID}/dup`, tag: 'equivalent' }
    const find = createIncrementalResolvedWorktreeLookup([first, equivalent])

    expect(find(`${ROOT_ID}/dup`)).toBe(first)
  })

  it('stops indexing at the first match and never reads later ids', () => {
    const reads: string[] = []
    const spyWorktree = (raw: string) => ({
      get id() {
        reads.push(raw)
        return raw
      }
    })
    const owner = spyWorktree(`${ROOT_ID}/first`)
    const unusedA = spyWorktree(`${ROOT_ID}/unused-a`)
    const unusedB = spyWorktree(`${ROOT_ID}/unused-b`)
    const find = createIncrementalResolvedWorktreeLookup([owner, unusedA, unusedB])

    expect(find(`${ROOT_ID}/first`)).toBe(owner)
    // Only the matched owner's id is read; a linear Array.find would touch every entry.
    expect(reads).toEqual([`${ROOT_ID}/first`])
  })

  it('keeps parsed and raw identity domains distinct', () => {
    const parsed = { id: `${ROOT_ID}/collision` }
    const raw = { id: `${REPO_ID}\0${FOLDER_PATH}/collision` }
    const find = createIncrementalResolvedWorktreeLookup([parsed, raw])

    expect(find(raw.id)).toBe(raw)
    expect(find(parsed.id)).toBe(parsed)
  })

  it('returns undefined when no worktree matches', () => {
    const find = createIncrementalResolvedWorktreeLookup([{ id: `${ROOT_ID}/a` }])

    expect(find(`${ROOT_ID}/missing`)).toBeUndefined()
  })
})

describe('runtimeWorktreeLookupKey', () => {
  it('folds path spelling but separates parsed and raw domains', () => {
    expect(runtimeWorktreeLookupKey(`${ROOT_ID}/p/`)).toBe(runtimeWorktreeLookupKey(`${ROOT_ID}/p`))
    expect(runtimeWorktreeLookupKey(`${REPO_ID}\0${FOLDER_PATH}/p`)).not.toBe(
      runtimeWorktreeLookupKey(`${ROOT_ID}/p`)
    )
  })
})

type RuntimeInternals = {
  buildResolvedWorktreeFromId: (worktreeId: string) => { id: string } | null
  refreshPtyWorktreeRecordsWithControllerInventory: (
    resolvedWorktrees: unknown[]
  ) => Promise<unknown>
  ptysById: Map<string, { worktreeId: string }>
}

function createRuntimeInternals(sessions: unknown[]): RuntimeInternals {
  const meta: Record<string, Record<string, unknown>> = {}
  const store = {
    getRepos: () => [REPO],
    getRepo: (id: string) => (id === REPO_ID ? REPO : undefined),
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (worktreeId: string) => meta[worktreeId],
    setWorktreeMeta: (worktreeId: string, patch: Record<string, unknown>) => {
      meta[worktreeId] = { ...meta[worktreeId], ...patch }
      return meta[worktreeId]
    },
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  } as never
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait: async () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => sessions
  } as never)
  return runtime as unknown as RuntimeInternals
}

// Reachability: the indexed lookup must drive the real controller-inventory refresh,
// not just the unit above, so exercise it through the production PTY-owner resolution.
describe('PTY worktree inventory resolution reaches the indexed lookup', () => {
  it('keeps the first resolved worktree when normalized owner identities collide', async () => {
    const firstId = `${ROOT_ID}/duplicate/`
    const equivalentId = `${ROOT_ID}/duplicate`
    const laterId = `${ROOT_ID}/later`
    const internals = createRuntimeInternals([
      { id: 'later-owner-pty', worktreeId: laterId, cwd: FOLDER_PATH, title: 'shell' },
      { id: 'duplicate-owner-pty', worktreeId: equivalentId, cwd: FOLDER_PATH, title: 'shell' }
    ])
    const resolvedWorktrees = [firstId, equivalentId, laterId].map((id) =>
      internals.buildResolvedWorktreeFromId(id)
    )

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(resolvedWorktrees)

    expect(internals.ptysById.get('duplicate-owner-pty')?.worktreeId).toBe(firstId)
  })

  it('keeps parsed and raw owner identity domains distinct', async () => {
    const parsedId = `${ROOT_ID}/collision`
    const rawId = `${REPO_ID}\0${FOLDER_PATH}/collision`
    const internals = createRuntimeInternals([
      { id: 'raw-owner-pty', worktreeId: rawId, cwd: FOLDER_PATH, title: 'shell' }
    ])
    const parsedWorktree = internals.buildResolvedWorktreeFromId(parsedId)
    expect(parsedWorktree).toBeTruthy()
    const rawWorktree = { ...(parsedWorktree as { id: string }), id: rawId }

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([parsedWorktree, rawWorktree])

    expect(internals.ptysById.get('raw-owner-pty')?.worktreeId).toBe(rawId)
  })
})
