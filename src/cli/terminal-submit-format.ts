/**
 * Printer for `orca terminal submit` — §5.2's verdict, rendered without editing
 * it (docs/reference/alab-auto-mode-design.md).
 *
 * The one rule this file exists to keep: `'unknown'` is never collapsed into
 * failure. It means the prompt may well have been submitted and the verifier
 * could not prove it either way, so resending it would be a duplicate turn in a
 * live agent. It therefore prints its own line, carries its own exit code, and
 * says out loud that retrying is forbidden.
 *
 * The payload is typed structurally rather than imported from the runtime: the
 * CLI builds against `src/shared` only, and its job here is to print what the
 * server said, not to re-decide it.
 */

export type CliTerminalSubmitVerdict = {
  handle: string
  operationId: string
  phase: string
  submitted: 'yes' | 'no' | 'unknown'
  evidence: string
  retry: 'allowed' | 'forbidden'
  escalate: boolean
  attempts: number
  draftState: string
  evidenceChannel: string
  trailingSignals: number
  refusal?: { code: string; reason: string }
  preemption?: { cause: string; phase: string; humanSource?: string }
}

/** 0 submitted, 1 definitively not submitted, 2 unknown. Unknown gets its own
 *  code so a shell cannot read "we could not tell" as "it failed, try again". */
export const TERMINAL_SUBMIT_EXIT_CODES = { yes: 0, no: 1, unknown: 2 } as const

export function terminalSubmitExitCode(verdict: CliTerminalSubmitVerdict): number {
  return TERMINAL_SUBMIT_EXIT_CODES[verdict.submitted]
}

function submittedLine(verdict: CliTerminalSubmitVerdict): string {
  if (verdict.submitted === 'yes') {
    return 'submitted: yes'
  }
  if (verdict.submitted === 'no') {
    return 'submitted: no'
  }
  return 'submitted: unknown'
}

export function formatTerminalSubmit(result: { submit: CliTerminalSubmitVerdict }): string {
  const verdict = result.submit
  const lines = [
    `handle: ${verdict.handle}`,
    submittedLine(verdict),
    `evidence: ${verdict.evidence}`,
    `phase: ${verdict.phase}`,
    `attempts: ${verdict.attempts}`,
    `draft: ${verdict.draftState}`,
    `retry: ${verdict.retry}`,
    `operationId: ${verdict.operationId}`
  ]
  if (verdict.evidenceChannel !== 'intact') {
    lines.push('warning: evidence channel was lossy — silence could not be trusted')
  }
  if (verdict.trailingSignals > 0) {
    // §5.2a: a later signal is a nested child agent's turn, never a second submit.
    lines.push(`note: ${verdict.trailingSignals} later submit signal(s) seen; not a second submit`)
  }
  if (verdict.refusal) {
    lines.push(`refused (${verdict.refusal.code}): ${verdict.refusal.reason}`)
  }
  if (verdict.preemption) {
    const who = verdict.preemption.humanSource ? ` by ${verdict.preemption.humanSource}` : ''
    lines.push(`preempted${who} (${verdict.preemption.cause}) at phase ${verdict.preemption.phase}`)
  }
  if (verdict.escalate) {
    lines.push('escalate: the submit could not be proved or disproved — do NOT resend it')
  }
  return lines.join('\n')
}
