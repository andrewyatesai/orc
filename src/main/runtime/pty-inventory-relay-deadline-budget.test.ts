import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

// STA-517: the worktree.ps liveness refresh is the only thing that retires an exited PTY, and mobile
// renders "active" straight off the summary it produces. Its aggregate inventory must reach each
// provider under its own budget — an unbounded SSH list runs to the mux's 30s default, blowing the
// whole 3s refresh so nothing is ever retired and every retained pane stays "active" indefinitely.

// Mirrors the runtime's own PTY_CONTROLLER_LIST_TIMEOUT_MS; the forwarded deadline lands inside it.
const LIST_BUDGET_MS = 3000

type ListCall = { deadlineMs: number | undefined }

type RuntimeInventoryInternals = {
  refreshPtyWorktreeRecordsWithControllerInventory: (
    resolvedWorktrees: unknown[],
    targetWorktreeId?: string | null,
    deadline?: number
  ) => Promise<unknown>
}

function createRuntime(): { internals: RuntimeInventoryInternals; calls: ListCall[] } {
  const calls: ListCall[] = []
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    // Present so the runtime's `listProcesses`-capability guard passes, exactly as the real pty.ts
    // controller exposes both; the scoped variant below is the branch the app actually drives.
    listProcesses: async () => [],
    // Why: the production pty.ts controller exposes the scoped variant, so this is the branch the
    // app actually drives; it must receive the runtime's bounded deadline, not run unbounded.
    listProcessesWithHostScope: async (opts?: { deadlineMs?: number }) => {
      calls.push({ deadlineMs: opts?.deadlineMs })
      return { processes: [], hostIds: [] }
    }
  } as never)
  return { internals: runtime as unknown as RuntimeInventoryInternals, calls }
}

describe('pty inventory refresh forwards a bounded relay deadline', () => {
  it('gives the provider a deadline strictly inside its own list budget', async () => {
    const { internals, calls } = createRuntime()
    const before = Date.now()

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([])

    expect(calls).toHaveLength(1)
    const { deadlineMs } = calls[0]!
    // Unbounded, an SSH list runs to the mux's 30s default and the whole refresh expires, so no
    // inventory ever arrives and nothing is retired (STA-517).
    expect(deadlineMs).toBeDefined()
    expect(deadlineMs!).toBeGreaterThan(before)
    // Strictly inside the budget: the aggregate needs a margin to collect providers that answered
    // after a stalled one gives up, rather than expiring at the same instant and discarding all.
    expect(deadlineMs!).toBeLessThan(before + LIST_BUDGET_MS)
  })

  it('honours a caller deadline tighter than the list budget', async () => {
    const { internals, calls } = createRuntime()
    const callerDeadline = Date.now() + 400

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([], null, callerDeadline)

    expect(calls[0]!.deadlineMs!).toBeLessThanOrEqual(callerDeadline)
  })
})
