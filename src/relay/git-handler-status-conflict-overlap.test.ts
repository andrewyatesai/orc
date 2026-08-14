import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromises from 'node:fs/promises'
import type { GitExec } from './git-handler-ops'
import type { RelayGitStreamExec } from './git-stdout-stream'

// Why: the conflict detector reads `<worktree>/.git` to resolve the git dir; a
// controllable readFile lets us hold that marker I/O pending while asserting the
// status stream has already started (the #13529 overlap).
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return { ...actual, readFile: readFileMock }
})

import { getStatusOp } from './git-handler-status-ops'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

const GITDIR_MARKER = 'gitdir: /repo/.git/worktrees/feature\n'
const relayGit: GitExec = async () => ({ stdout: '', stderr: '' })

describe('getStatusOp conflict-read overlap (#13529)', () => {
  beforeEach(() => {
    readFileMock.mockReset()
    readFileMock.mockResolvedValue(GITDIR_MARKER)
  })

  it('starts the relay status stream before conflict-marker I/O settles', async () => {
    const markerRead = deferred<string>()
    const statusStarted = deferred<void>()
    readFileMock.mockReturnValue(markerRead.promise)
    const streamGit: RelayGitStreamExec = async () => {
      statusStarted.resolve()
      return { stoppedEarly: false }
    }

    const resultPromise = getStatusOp(relayGit, streamGit, { worktreePath: '/repo' })
    // A serialized path would never reach the status read until the marker resolved,
    // so this await would hang — reaching it proves the two reads overlap.
    await statusStarted.promise
    expect(readFileMock).toHaveBeenCalledWith(join('/repo', '.git'), 'utf-8')

    markerRead.resolve(GITDIR_MARKER)
    await expect(resultPromise).resolves.toMatchObject({
      entries: [],
      conflictOperation: 'unknown'
    })
  })

  it('keeps a fast relay status failure fail-soft while the marker read is still pending', async () => {
    // Guards rejection ownership: the scan rejects immediately, but the marker read
    // is held pending — without allSettled taking ownership up front, that rejection
    // would go unhandled in this window and vitest would fail the test.
    const markerRead = deferred<string>()
    readFileMock.mockReturnValue(markerRead.promise)
    let settled = false
    const streamGit: RelayGitStreamExec = async () => {
      throw new Error('status failed first')
    }

    const resultPromise = getStatusOp(relayGit, streamGit, { worktreePath: '/repo' }).finally(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    markerRead.resolve(GITDIR_MARKER)
    await expect(resultPromise).resolves.toMatchObject({
      entries: [],
      conflictOperation: 'unknown'
    })
  })

  it('rethrows the original relay status failure after cancellation', async () => {
    const controller = new AbortController()
    const statusError = new Error('cancelled status')
    const streamGit: RelayGitStreamExec = async () => {
      controller.abort(statusError)
      throw statusError
    }

    await expect(
      getStatusOp(relayGit, streamGit, { worktreePath: '/repo' }, { signal: controller.signal })
    ).rejects.toBe(statusError)
  })

  it('surfaces detector errors without waiting for a hung status read', async () => {
    const statusStarted = deferred<void>()
    const streamGit: RelayGitStreamExec = () => {
      statusStarted.resolve()
      return new Promise(() => {})
    }
    // A non-string worktree makes path.join in the detector throw a TypeError.
    const invalidPath = { toString: () => '/repo' } as unknown as string

    const resultPromise = getStatusOp(relayGit, streamGit, { worktreePath: invalidPath })
    const rejection = expect(resultPromise).rejects.toThrow(TypeError)
    await statusStarted.promise
    await rejection
  })

  it('keeps detector errors ahead of a concurrent status failure', async () => {
    const streamGit = (() => {
      throw new Error('status failed too')
    }) as RelayGitStreamExec
    const invalidPath = { toString: () => '/repo' } as unknown as string

    await expect(
      getStatusOp(relayGit, streamGit, { worktreePath: invalidPath })
    ).rejects.toBeInstanceOf(TypeError)
  })
})
