import { describe, expect, it } from 'vitest'
import { decideUnattendedAgentDispatch } from './unattended-agent-dispatch'
import {
  SAFE_TUI_AGENT_ARGS,
  SAFE_TUI_AGENT_ENV,
  YOLO_TUI_AGENT_ARGS
} from './tui-agent-permissions'

describe('decideUnattendedAgentDispatch', () => {
  it('never refuses outside the Safe preset — existing fleets are untouched', () => {
    for (const preset of ['yolo', 'manual', undefined, 'garbage']) {
      expect(
        decideUnattendedAgentDispatch({
          preset,
          agent: 'claude',
          agentArgs: YOLO_TUI_AGENT_ARGS.claude
        })
      ).toEqual({ refuse: false })
    }
  })

  it('allows a terminal with no identified agent — nothing to judge', () => {
    expect(decideUnattendedAgentDispatch({ preset: 'safe', agent: null })).toEqual({
      refuse: false
    })
    expect(decideUnattendedAgentDispatch({ preset: 'safe', agent: undefined })).toEqual({
      refuse: false
    })
  })

  it('allows a verified safe launch', () => {
    expect(
      decideUnattendedAgentDispatch({
        preset: 'safe',
        agent: 'codex',
        agentArgs: SAFE_TUI_AGENT_ARGS.codex,
        agentEnv: {}
      })
    ).toEqual({ refuse: false })
    expect(
      decideUnattendedAgentDispatch({
        preset: 'safe',
        agent: 'gemini',
        agentArgs: SAFE_TUI_AGENT_ARGS.gemini,
        agentEnv: SAFE_TUI_AGENT_ENV.gemini
      })
    ).toEqual({ refuse: false })
  })

  it('refuses agents with no OS sandbox, regardless of their flags', () => {
    for (const agentArgs of ['', YOLO_TUI_AGENT_ARGS.aider, '--whatever']) {
      const decision = decideUnattendedAgentDispatch({ preset: 'safe', agent: 'aider', agentArgs })
      expect(decision.refuse).toBe(true)
      if (decision.refuse) {
        expect(decision.reason).toContain('no OS sandbox')
      }
    }
  })

  it('refuses a confinable agent launched with bypass flags', () => {
    const decision = decideUnattendedAgentDispatch({
      preset: 'safe',
      agent: 'codex',
      agentArgs: YOLO_TUI_AGENT_ARGS.codex
    })
    expect(decision.refuse).toBe(true)
    if (decision.refuse) {
      expect(decision.reason).toContain('bypass flags')
    }
  })

  it('refuses manual and unverifiable-custom launches — fail closed, with the fix named', () => {
    // Manual would stall unattended on its first prompt; custom flags cannot be verified confined.
    for (const agentArgs of ['', '--sandbox workspace-write --model gpt-5']) {
      const decision = decideUnattendedAgentDispatch({ preset: 'safe', agent: 'codex', agentArgs })
      expect(decision.refuse).toBe(true)
      if (decision.refuse) {
        expect(decision.reason).toContain('Safe preset')
      }
    }
  })

  it('refuses a gemini whose sandbox env was tampered with', () => {
    // GEMINI_SANDBOX beats the --sandbox flag inside gemini, so a poisoned env is unconfined.
    const decision = decideUnattendedAgentDispatch({
      preset: 'safe',
      agent: 'gemini',
      agentArgs: SAFE_TUI_AGENT_ARGS.gemini,
      agentEnv: { GEMINI_SANDBOX: 'false' }
    })
    expect(decision.refuse).toBe(true)
  })
})
