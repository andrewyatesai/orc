/**
 * The CLI's one job on this verb is to not lie about `unknown`. These pin that
 * it prints its own verdict word, carries its own exit code, and says out loud
 * that resending is forbidden (§5.2 of docs/reference/alab-auto-mode-design.md).
 */
import { describe, expect, it } from 'vitest'
import {
  formatTerminalSubmit,
  terminalSubmitExitCode,
  type CliTerminalSubmitVerdict
} from './terminal-submit-format'

function verdict(overrides: Partial<CliTerminalSubmitVerdict> = {}): CliTerminalSubmitVerdict {
  return {
    handle: 'term_abc123',
    operationId: 'op-1',
    phase: 'verify',
    submitted: 'yes',
    evidence: 'certified-submit-signal',
    retry: 'forbidden',
    escalate: false,
    attempts: 1,
    draftState: 'clean',
    evidenceChannel: 'intact',
    trailingSignals: 0,
    ...overrides
  }
}

describe('formatTerminalSubmit', () => {
  it('names the evidence tier a yes was decided on', () => {
    const printed = formatTerminalSubmit({ submit: verdict() })
    expect(printed).toContain('submitted: yes')
    expect(printed).toContain('evidence: certified-submit-signal')
  })

  it('prints unknown as unknown, with the do-not-resend warning', () => {
    const printed = formatTerminalSubmit({
      submit: verdict({
        submitted: 'unknown',
        evidence: 'suppressed-hook',
        escalate: true,
        draftState: 'unknown'
      })
    })
    expect(printed).toContain('submitted: unknown')
    expect(printed).not.toContain('submitted: no')
    expect(printed).toContain('do NOT resend')
  })

  it('surfaces a lossy evidence channel rather than hiding it behind the verdict', () => {
    const printed = formatTerminalSubmit({
      submit: verdict({ submitted: 'unknown', escalate: true, evidenceChannel: 'lossy' })
    })
    expect(printed).toContain('evidence channel was lossy')
  })

  it('reports a refusal with the reason that names the fix', () => {
    const printed = formatTerminalSubmit({
      submit: verdict({
        submitted: 'no',
        phase: 'refused',
        evidence: 'not-attempted',
        attempts: 0,
        refusal: { code: 'unattended-dispatch', reason: 'relaunch it with the Safe preset' }
      })
    })
    expect(printed).toContain('refused (unattended-dispatch): relaunch it with the Safe preset')
  })

  it('reports a human takeover as a preemption, not as a plain failure', () => {
    const printed = formatTerminalSubmit({
      submit: verdict({
        submitted: 'no',
        evidence: 'preempted-before-enter',
        draftState: 'contaminated',
        preemption: { cause: 'human-input', phase: 'pasting', humanSource: 'desktop' }
      })
    })
    expect(printed).toContain('preempted by desktop (human-input) at phase pasting')
    expect(printed).toContain('draft: contaminated')
  })

  it('calls a nested child’s later signal what it is', () => {
    const printed = formatTerminalSubmit({ submit: verdict({ trailingSignals: 2 }) })
    expect(printed).toContain('not a second submit')
  })
})

describe('terminalSubmitExitCode', () => {
  it('keeps unknown distinguishable from a clean no', () => {
    expect(terminalSubmitExitCode(verdict({ submitted: 'yes' }))).toBe(0)
    expect(terminalSubmitExitCode(verdict({ submitted: 'no' }))).toBe(1)
    expect(terminalSubmitExitCode(verdict({ submitted: 'unknown' }))).toBe(2)
  })
})
