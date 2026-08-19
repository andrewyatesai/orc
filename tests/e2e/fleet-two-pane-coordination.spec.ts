import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { sendToTerminal } from './helpers/terminal'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { ensureActiveWorktreePaneLoad } from './artificial-opencode-pane-interactions'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import { nodeTerminalCommand } from './terminal-node-command'
import { buildFreshShellProbeInputSequence } from './terminal-probe-input-sequence'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { splitWorktreeIdForFilesystem } from '../../src/shared/worktree-id-parsing'

// R0's LIVE acceptance: two real panes coordinate through the real store.
//
// Everything fleet-related is otherwise verified by unit tests and Rust/TS
// parity; nothing had watched a coordinator PANE dispatch to a worker PANE and
// the claim verdict come back out of `alab.consoleSnapshot`. This spec drives
// only production construction paths:
//
//   - every orchestration verb is the REAL `orca` CLI (out/cli/index.js),
//     spawned inside the pane's own shell with the pane's own env
//     (ORCA_TERMINAL_HANDLE / ORCA_USER_DATA_PATH), over the runtime's unix
//     socket to the registered RPC methods — never a hand-built double;
//   - the store is the real Rust orchestration DB (schema v11) in this test
//     app's isolated userData;
//   - `orchestration.run` starts the real Coordinator loop, whose live-run
//     worktree registration is the only thing that turns a claim into a git
//     comparison (§8.4);
//   - the console read is `alab.consoleSnapshot` through the same
//     window.api.runtime.call seam the fleet console UI polls, gated behind
//     the orchestration experiment flag exactly as production is
//     (ORCA_EXPERIMENTAL_ORCHESTRATION — the documented headless/e2e override).
//
// The one deliberately-out-of-scope piece: the worker "agents" are the panes'
// real shells running the real CLI, not a live claude/codex TUI — headless CI
// has no agent binary, so `dispatch --inject` (paste-into-agent) stays covered
// by its unit tests. Everything else — pane identity, capability mint/verify,
// lifecycle reconcile, adoption, live git reconciliation — is exercised live.

type CliOutcome = { status: number | null; stdout: string; stderr: string }
type RpcEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: string; message: string } }

// Records the CLI outcome where the test can read it without scraping wrapped
// terminal output; the CLI itself still runs inside the pane's shell.
const CLI_PANE_RUNNER_SOURCE = `import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const [cliEntry, outFile, ...cliArgs] = process.argv.slice(2)
const run = spawnSync(process.execPath, [cliEntry, ...cliArgs], { encoding: 'utf8' })
writeFileSync(
  outFile,
  JSON.stringify({ status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' })
)
`

// Huge on purpose: the run must still be LIVE (worktree registered) when the
// snapshot is taken — convergence on the next tick would degrade every claim
// verdict to `unknown`. The app is torn down long before this ever fires.
const RUN_POLL_INTERVAL_MS = 600_000

async function rendererRuntimeCall<T>(
  page: Page,
  method: string,
  params?: unknown
): Promise<RpcEnvelope<T>> {
  return page.evaluate(
    async ({ method, params }) => {
      const api = (
        window as unknown as {
          api: {
            runtime: { call: (args: { method: string; params?: unknown }) => Promise<unknown> }
          }
        }
      ).api
      return (await api.runtime.call({ method, params })) as
        | { ok: true; result: unknown }
        | { ok: false; error: { code: string; message: string } }
    },
    { method, params }
  ) as Promise<RpcEnvelope<T>>
}

function expectRpcOk<T>(envelope: RpcEnvelope<T>, label: string): T {
  if (!envelope.ok) {
    throw new Error(`${label} failed: ${envelope.error.code}: ${envelope.error.message}`)
  }
  return envelope.result
}

// Mirrors the console's own read (`getStatus` runs --untracked-files=all), so
// the honest worker can claim exactly what git will report at snapshot time.
function gitChangedPaths(worktreePath: string): string[] {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: worktreePath,
    encoding: 'utf8'
  })
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
}

async function runOrcaCliInPane(args: {
  page: Page
  ptyId: string
  scratchDir: string
  runnerPath: string
  cliEntry: string
  cliArgs: readonly string[]
  label: string
}): Promise<CliOutcome> {
  const outFile = path.join(args.scratchDir, `${args.label}-${randomUUID()}.json`)
  const command = `${nodeTerminalCommand([args.runnerPath, args.cliEntry, outFile, ...args.cliArgs])}\r`
  for (const input of buildFreshShellProbeInputSequence(command)) {
    await sendToTerminal(args.page, args.ptyId, input)
  }
  let outcome: CliOutcome | null = null
  await expect
    .poll(
      () => {
        if (!existsSync(outFile)) {
          return false
        }
        try {
          outcome = JSON.parse(readFileSync(outFile, 'utf8')) as CliOutcome
          return true
        } catch {
          // Partially-flushed file: poll again.
          return false
        }
      },
      {
        timeout: 60_000,
        message: `orca ${args.cliArgs.join(' ')} (${args.label}) never finished in the pane`
      }
    )
    .toBe(true)
  return outcome!
}

function parseCliResult<T>(outcome: CliOutcome, label: string): T {
  expect(outcome.status, `${label} exit status (stderr tail: ${outcome.stderr.slice(-400)})`).toBe(
    0
  )
  return (JSON.parse(outcome.stdout) as { result: T }).result
}

type SnapshotTask = { id: string; status: string; result: string | null; run_id: string | null }
type ConsoleSnapshot = {
  runs: {
    id: string
    live: boolean
    status: string
    tasks: { completed: number; failed: number; dispatched: number; total: number }
    pendingGates: number
  }[]
  exceptions: { taskId: string; kind: string; summary: string }[]
  tasks: SnapshotTask[]
  reconciliations: { taskId: string; verdict: string; summary: string }[]
}

test.describe('R0 fleet live acceptance @fleet-two-pane', () => {
  // Production gating: the experiment env override is the documented enablement
  // for headless/e2e runtimes (fleet-experimental-gate.ts). The companion
  // describe below proves the same build REFUSES the verb without it.
  test.use({ orcaAppExtraEnv: { ORCA_EXPERIMENTAL_ORCHESTRATION: '1' } })

  test('a coordinator pane dispatches, worker panes claim, and the console snapshot reconciles the claims against real git', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    test.setTimeout(300_000)
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const worktreePath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    if (!worktreePath) {
      throw new Error(`active worktree id did not split to a filesystem path: ${worktreeId}`)
    }

    // Three REAL panes in the workspace: one coordinator, two workers.
    const [coordinatorPane, workerAPane, workerBPane] = await ensureActiveWorktreePaneLoad(
      orcaPage,
      3
    )
    for (const pane of [coordinatorPane, workerAPane, workerBPane]) {
      if (!pane?.ptyId) {
        throw new Error('expected three PTY-bound panes for the fleet acceptance flow')
      }
      await waitForPtyShellEcho(orcaPage, pane.ptyId, 30_000)
    }

    // The runtime's own pane→handle registry names the participants — the same
    // resolution the CLI uses when a pane omits --terminal.
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const client = new RuntimeClient(userDataDir, 30_000, null, null)
    const resolveHandle = async (paneKey: string): Promise<string> => {
      const response = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
        paneKey
      })
      return response.result.terminal.handle
    }
    const coordinatorHandle = await resolveHandle(coordinatorPane.paneKey)
    const workerAHandle = await resolveHandle(workerAPane.paneKey)
    const workerBHandle = await resolveHandle(workerBPane.paneKey)
    expect(new Set([coordinatorHandle, workerAHandle, workerBHandle]).size).toBe(3)

    const markerId = randomUUID().slice(0, 8)
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-fleet-e2e-'))
    const runnerPath = path.join(scratchDir, 'orca-cli-pane-runner.mjs')
    writeFileSync(runnerPath, CLI_PANE_RUNNER_SOURCE)
    const cliEntry = path.join(process.cwd(), 'out', 'cli', 'index.js')
    const workFilePath = path.join(worktreePath, 'src', 'index.ts')
    const workFileOriginal = readFileSync(workFilePath, 'utf8')
    const phantomFile = `src/phantom-${markerId}.ts`
    let runId: string | null = null

    const cliInPane = (
      ptyId: string,
      label: string,
      cliArgs: readonly string[]
    ): Promise<CliOutcome> =>
      runOrcaCliInPane({ page: orcaPage, ptyId, scratchDir, runnerPath, cliEntry, cliArgs, label })

    try {
      // ── The coordinator pane creates two tasks through its own CLI ──
      const createTask = async (label: string, spec: string): Promise<string> => {
        const outcome = await cliInPane(coordinatorPane.ptyId, label, [
          'orchestration',
          'task-create',
          '--spec',
          spec,
          '--task-title',
          label,
          '--json'
        ])
        const { task } = parseCliResult<{ task: { id: string; status: string } }>(outcome, label)
        expect(task.status, `${label} starts ready (no deps)`).toBe('ready')
        return task.id
      }
      const honestTaskId = await createTask(
        `fleet-${markerId}-honest`,
        `Fleet live acceptance ${markerId}: append a marker line to src/index.ts`
      )
      const lyingTaskId = await createTask(
        `fleet-${markerId}-lying`,
        `Fleet live acceptance ${markerId}: claim ${phantomFile} without touching it`
      )

      // ── The coordinator pane dispatches one task to each worker pane ──
      const dispatchTo = async (
        label: string,
        taskId: string,
        workerHandle: string
      ): Promise<{ dispatchId: string; capability: string | undefined }> => {
        const outcome = await cliInPane(coordinatorPane.ptyId, label, [
          'orchestration',
          'dispatch',
          '--task',
          taskId,
          '--to',
          workerHandle,
          '--from',
          coordinatorHandle,
          '--return-preamble',
          '--json'
        ])
        const { dispatch, preamble } = parseCliResult<{
          dispatch: { id: string; task_id: string; status: string } | null
          preamble?: string
        }>(outcome, label)
        expect(dispatch?.task_id).toBe(taskId)
        expect(dispatch?.status).toBe('dispatched')
        // The dcap_ secret travels only inside the preamble (the channel a real
        // worker gets it from); with live panes the runtime can resolve pane +
        // process incarnation, so the v10 capability must actually mint.
        const capability = preamble?.match(/--dispatch-capability (\S+)/)?.[1]
        expect(capability, `${label} minted a dispatch capability`).toBeTruthy()
        return { dispatchId: dispatch!.id, capability }
      }
      const honestDispatch = await dispatchTo('dispatch-honest', honestTaskId, workerAHandle)
      const lyingDispatch = await dispatchTo('dispatch-lying', lyingTaskId, workerBHandle)

      // ── The coordinator pane starts the REAL coordinator loop ──
      // Both tasks are already dispatched, so the first tick spawns nothing;
      // run creation atomically adopts the un-owned live tasks (run-ownership),
      // and the live run's worktree is what powers the §8.4 claim check.
      const runOutcome = await cliInPane(coordinatorPane.ptyId, 'run-start', [
        'orchestration',
        'run',
        '--spec',
        `Fleet live acceptance run ${markerId}`,
        '--from',
        coordinatorHandle,
        '--worktree',
        worktreeId,
        '--poll-interval-ms',
        String(RUN_POLL_INTERVAL_MS),
        '--json'
      ])
      const runResult = parseCliResult<{ runId: string; status: string }>(runOutcome, 'run-start')
      runId = runResult.runId
      expect(runResult.status).toBe('running')

      const adopted = expectRpcOk(
        await rendererRuntimeCall<{ tasks: { id: string; status: string }[] }>(
          orcaPage,
          'orchestration.taskList',
          { runId }
        ),
        'run-scoped taskList'
      )
      expect(
        adopted.tasks.map((task) => task.id).sort(),
        'run start adopted both dispatched tasks'
      ).toEqual([honestTaskId, lyingTaskId].sort())

      // ── Worker A does REAL work in its own pane, then claims exactly it ──
      const appendCommand = `${nodeTerminalCommand([
        '-e',
        `require('fs').appendFileSync(${JSON.stringify(workFilePath)}, ${JSON.stringify(
          `\n// fleet worker ${markerId}\n`
        )})`
      ])}\r`
      for (const input of buildFreshShellProbeInputSequence(appendCommand)) {
        await sendToTerminal(orcaPage, workerAPane.ptyId, input)
      }
      await expect
        .poll(() => gitChangedPaths(worktreePath).includes('src/index.ts'), {
          timeout: 20_000,
          message: 'worker A’s edit never appeared in git status'
        })
        .toBe(true)
      // Claim the full changed set so a pre-dirtied shared repo cannot turn the
      // honest verdict into a spurious mismatch.
      const honestClaim = gitChangedPaths(worktreePath)

      const honestDone = await cliInPane(workerAPane.ptyId, 'worker-a-done', [
        'orchestration',
        'send',
        '--to',
        coordinatorHandle,
        '--from',
        workerAHandle,
        '--type',
        'worker_done',
        '--subject',
        `Done ${markerId}`,
        '--body',
        'Appended the marker line to src/index.ts. Verified via git status. Nothing left.',
        '--task-id',
        honestTaskId,
        '--dispatch-id',
        honestDispatch.dispatchId,
        '--files-modified',
        honestClaim.join(','),
        ...(honestDispatch.capability ? ['--dispatch-capability', honestDispatch.capability] : []),
        '--json'
      ])
      const honestSend = parseCliResult<{
        message: { id: string }
        lifecycle?: { action: string; reason?: string }
      }>(honestDone, 'worker-a-done')
      expect(honestSend.lifecycle?.action, 'honest claim accepted').not.toBe('rejected')

      const afterHonest = expectRpcOk(
        await rendererRuntimeCall<{ tasks: SnapshotTask[] }>(orcaPage, 'orchestration.taskList', {
          runId
        }),
        'taskList after honest claim'
      )
      const honestRow = afterHonest.tasks.find((task) => task.id === honestTaskId)
      expect(honestRow?.status, 'the claim round-tripped into the store').toBe('completed')
      const honestResult = JSON.parse(honestRow?.result ?? 'null') as {
        completedBy: string
        filesModified: string[]
      }
      expect(honestResult.completedBy).toBe(workerAHandle)
      expect(honestResult.filesModified.sort()).toEqual([...honestClaim].sort())

      // ── A forged worker_done from the WRONG pane must be rejected ──
      // Sent from the coordinator pane with the right task/dispatch ids but no
      // capability and the wrong sender identity: the guard must fail closed
      // under both the v10 capability regime and the pane-key fallback.
      const forgedDone = await cliInPane(coordinatorPane.ptyId, 'forged-done', [
        'orchestration',
        'send',
        '--to',
        coordinatorHandle,
        '--from',
        coordinatorHandle,
        '--type',
        'worker_done',
        '--subject',
        `Forged ${markerId}`,
        '--body',
        'A non-assignee pane claims the lying task is complete.',
        '--task-id',
        lyingTaskId,
        '--dispatch-id',
        lyingDispatch.dispatchId,
        '--files-modified',
        phantomFile,
        '--json'
      ])
      expect(forgedDone.status, 'CLI exits non-zero on a rejected lifecycle send').toBe(1)
      const forgedSend = JSON.parse(forgedDone.stdout) as {
        result: { lifecycle?: { action: string; code?: string } }
      }
      expect(forgedSend.result.lifecycle?.action).toBe('rejected')
      const afterForgery = expectRpcOk(
        await rendererRuntimeCall<{ tasks: SnapshotTask[] }>(orcaPage, 'orchestration.taskList', {
          runId
        }),
        'taskList after forged claim'
      )
      expect(
        afterForgery.tasks.find((task) => task.id === lyingTaskId)?.status,
        'a forged completion does not complete the task'
      ).toBe('dispatched')

      // ── Worker B lies: claims a file it never touched ──
      const lyingDone = await cliInPane(workerBPane.ptyId, 'worker-b-done', [
        'orchestration',
        'send',
        '--to',
        coordinatorHandle,
        '--from',
        workerBHandle,
        '--type',
        'worker_done',
        '--subject',
        `Done ${markerId} (allegedly)`,
        '--body',
        `Claimed ${phantomFile} without modifying anything.`,
        '--task-id',
        lyingTaskId,
        '--dispatch-id',
        lyingDispatch.dispatchId,
        '--files-modified',
        phantomFile,
        ...(lyingDispatch.capability ? ['--dispatch-capability', lyingDispatch.capability] : []),
        '--json'
      ])
      const lyingSend = parseCliResult<{ lifecycle?: { action: string } }>(
        lyingDone,
        'worker-b-done'
      )
      expect(lyingSend.lifecycle?.action, 'the lie is authorized, just false').not.toBe('rejected')

      // ── The console snapshot: one read, real git, live verdicts ──
      const snapshot = expectRpcOk(
        await rendererRuntimeCall<ConsoleSnapshot>(orcaPage, 'alab.consoleSnapshot', {}),
        'alab.consoleSnapshot'
      )

      const run = snapshot.runs.find((candidate) => candidate.id === runId)
      expect(run, 'the run appears on the console').toBeTruthy()
      expect(run?.live, 'the run is live (loop still parked on its poll timer)').toBe(true)
      expect(run?.tasks.completed).toBe(2)
      expect(run?.tasks.total).toBe(2)

      const verdictFor = (taskId: string) =>
        snapshot.reconciliations.find((row) => row.taskId === taskId)
      expect(
        verdictFor(honestTaskId)?.verdict,
        'honest claim reconciles as match against real git status'
      ).toBe('match')
      expect(verdictFor(honestTaskId)?.summary).toContain('claimed and changed')
      expect(
        verdictFor(lyingTaskId)?.verdict,
        'phantom claim is CONTRADICTED by real git status'
      ).toBe('mismatch')
      expect(verdictFor(lyingTaskId)?.summary).toContain('git does not show as changed')

      expect(
        snapshot.exceptions.some(
          (row) => row.kind === 'lifecycle-rejected' && row.taskId === lyingTaskId
        ),
        'the forged completion surfaces in the exceptions queue'
      ).toBe(true)

      // Evidence trail: what the console actually said, not just that asserts
      // passed (coordinator-acceptance's RESULT_JSON convention).
      const evidence = {
        runId,
        handles: { coordinatorHandle, workerAHandle, workerBHandle },
        honest: { taskId: honestTaskId, claim: honestClaim, row: verdictFor(honestTaskId) },
        lying: { taskId: lyingTaskId, claim: [phantomFile], row: verdictFor(lyingTaskId) },
        run: { live: run?.live, tasks: run?.tasks },
        exceptionKinds: snapshot.exceptions.map((row) => `${row.kind}:${row.taskId}`),
        capabilityMinted: Boolean(honestDispatch.capability && lyingDispatch.capability)
      }
      // eslint-disable-next-line no-console
      console.log(`[fleet-two-pane] RESULT_JSON ${JSON.stringify(evidence)}`)
      await testInfo.attach('fleet-two-pane-evidence.json', {
        body: JSON.stringify({ ...evidence, snapshot }, null, 2),
        contentType: 'application/json'
      })
    } finally {
      if (runId) {
        await client.call('orchestration.runStop', { runId }).catch(() => undefined)
      }
      writeFileSync(workFilePath, workFileOriginal)
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})

test.describe('R0 fleet experiment gate @fleet-two-pane', () => {
  // No ORCA_EXPERIMENTAL_ORCHESTRATION here: default settings ship the flag
  // off, and the fleet verb must refuse by NAMING the switch (the caller is an
  // agent; a bare method_not_found would send it hunting for a typo).
  test('the console snapshot verb refuses while the orchestration experiment is off', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const envelope = await rendererRuntimeCall<unknown>(orcaPage, 'alab.consoleSnapshot', {})
    expect(envelope.ok, 'the fleet verb is refused with the experiment off').toBe(false)
    if (envelope.ok) {
      return
    }
    expect(envelope.error.message).toContain('experimental fleet verb')
    expect(envelope.error.message).toContain('ORCA_EXPERIMENTAL_ORCHESTRATION')
  })
})
