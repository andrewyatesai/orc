// Walks a shell pid's process subtree (and its tmux pane, if any) to name the agent running under it.
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../shared/agent-process-recognition'
import { getFirstCommandToken } from '../shared/command-token-scanner'
import { getProcessTableSnapshot, type ProcessTableRow } from '../shared/process-table-snapshot'
import { resolveOuterWrapperForegroundProcess } from '../shared/foreground-wrapper-agent'
import { isTmuxClientCommand, resolveTmuxActivePanePid } from '../shared/tmux-active-pane'

function collectDescendants(
  rows: ProcessTableRow[],
  rootPid: number
): (ProcessTableRow & { depth: number })[] {
  const childrenByParent = new Map<number, ProcessTableRow[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }

  const descendants: (ProcessTableRow & { depth: number })[] = []
  const stack = (childrenByParent.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    descendants.push({ ...row, depth })
    for (const child of childrenByParent.get(row.pid) ?? []) {
      stack.push({ row: child, depth: depth + 1 })
    }
  }
  return descendants
}

function candidateScore(row: ProcessTableRow & { depth: number }): number {
  return (row.stat.includes('+') ? 10_000 : 0) + row.depth
}

function processCommandToken(command: string): string {
  return getFirstCommandToken(command)
}

function candidateMatchesFallbackWrapper(
  candidate: ProcessTableRow,
  fallbackProcess: string
): boolean {
  return isExpectedAgentProcess(processCommandToken(candidate.command), fallbackProcess)
}

function recognizeAgentInSubtree(
  rows: ProcessTableRow[],
  pid: number,
  fallbackProcess?: string | null
): string | null {
  const root = rows.find((row) => row.pid === pid)
  const candidates = collectDescendants(rows, pid).sort(
    (a, b) => candidateScore(b) - candidateScore(a)
  )
  // Why: SSH relays do not have the daemon's async wrapper cache. Inspect the
  // remote process tree so node/python agent entrypoints become real agents.
  const foregroundIsKnown =
    root?.stat.includes('+') === true ||
    candidates.some((candidate) => candidate.stat.includes('+'))
  const foregroundCandidates = foregroundIsKnown
    ? candidates.filter((candidate) => candidate.stat.includes('+'))
    : candidates
  const inspectionCandidates =
    fallbackProcess && isAgentForegroundWrapperProcess(fallbackProcess)
      ? foregroundCandidates.filter((candidate) =>
          candidateMatchesFallbackWrapper(candidate, fallbackProcess)
        )
      : foregroundCandidates
  if (
    fallbackProcess &&
    isAgentForegroundWrapperProcess(fallbackProcess) &&
    inspectionCandidates.length !== 1
  ) {
    return null
  }
  for (const candidate of inspectionCandidates) {
    const recognized = recognizeAgentProcessFromCommandLine(candidate.command)
    if (recognized) {
      // Why: return the outer wrapper (omp) rather than the deeper wrapped child
      // (pi) of a shell→omp→pi tree — see resolveOuterWrapperForegroundProcess.
      return resolveOuterWrapperForegroundProcess(recognized, candidate, candidates)
    }
  }
  return null
}

export async function getRecognizedForegroundDescendant(
  pid: number,
  fallbackProcess?: string | null
): Promise<string | null> {
  try {
    const rows = await getProcessTableSnapshot()
    const recognized = recognizeAgentInSubtree(rows, pid, fallbackProcess)
    if (recognized) {
      return recognized
    }
    // Agents run inside a user's tmux are children of the reparented tmux
    // server, not of the pane shell, so the subtree above misses them. If the
    // shell holds a tmux client, hop to its active pane pid and re-walk.
    const client = collectDescendants(rows, pid).find((row) => isTmuxClientCommand(row.command))
    if (client) {
      const panePid = await resolveTmuxActivePanePid(client.pid, client.command)
      if (panePid) {
        const inSubtree = recognizeAgentInSubtree(rows, panePid)
        if (inSubtree) {
          return inSubtree
        }
        // The agent can be the pane's own top process (e.g. `tmux new-session
        // claude`), which the subtree walk skips.
        const paneRow = rows.find((row) => row.pid === panePid)
        return paneRow
          ? (recognizeAgentProcessFromCommandLine(paneRow.command)?.processName ?? null)
          : null
      }
    }
  } catch {
    // Fall through to node-pty's process name or the root command name.
  }
  return null
}
