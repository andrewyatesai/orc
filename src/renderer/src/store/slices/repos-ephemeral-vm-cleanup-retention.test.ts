import { expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import {
  ephemeralVmCleanup,
  ephemeralVmListRuntimes,
  installReposRuntimeRoutingHarness,
  reposRemove,
  sshRepo
} from './repos-runtime-routing-fixture'
import { createTestStore } from './store-test-helpers'

// The fixture's beforeEach resets toast.* mocks, so sonner must be mocked here too.
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

installReposRuntimeRoutingHarness()

it('retains a runtime-owned SSH project when VM cleanup fails', async () => {
  const runtimeRepo: Repo = { ...sshRepo, connectionId: 'runtime-ssh-runtime-1' }
  ephemeralVmListRuntimes.mockResolvedValue([
    {
      id: 'runtime-1',
      cleanupStatus: 'not_started',
      sshTargetId: runtimeRepo.connectionId
    }
  ])
  // A failed destroy keeps the SSH target attached, so the runtime stays retryable.
  ephemeralVmCleanup.mockResolvedValue({
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    sshTargetId: runtimeRepo.connectionId
  })
  const store = createTestStore()
  store.setState({ repos: [runtimeRepo], activeRepoId: runtimeRepo.id })

  await store.getState().removeProject(runtimeRepo.id)

  // The project row survives and the backend removal never fired, so cleanup can be retried.
  expect(store.getState().repos).toEqual([runtimeRepo])
  expect(reposRemove).not.toHaveBeenCalled()
})
