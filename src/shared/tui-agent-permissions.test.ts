import { describe, expect, it } from 'vitest'
import {
  agentSupportsConfinedLaunch,
  getPresetAgentArgs,
  getPresetAgentEnv,
  reconcileAgentProfileWithPreset,
  SAFE_TUI_AGENT_ENV,
  applyAgentPermissionMode,
  resolveAgentPermissionModeSummary,
  resolveTuiAgentPermissionMode,
  SAFE_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from './tui-agent-permissions'

describe('tui agent permissions', () => {
  it('recognizes the current default profile as yolo', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })
    ).toBe('yolo')
  })

  it('recognizes an empty profile as manual', () => {
    expect(resolveAgentPermissionModeSummary({ agentDefaultArgs: {}, agentDefaultEnv: {} })).toBe(
      'manual'
    )
  })

  it('preserves custom agent arguments when applying manual mode', () => {
    const result = applyAgentPermissionMode({
      mode: 'manual',
      agentDefaultArgs: {
        claude: '--dangerously-skip-permissions',
        codex: '--model gpt-5'
      },
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })

    expect(result.agentDefaultArgs.claude).toBe('')
    expect(result.agentDefaultArgs.codex).toBe('--model gpt-5')
    expect(result.agentDefaultEnv.goose).toEqual({})
  })

  it('reports mixed when custom arguments are present', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: {
          ...YOLO_TUI_AGENT_ARGS,
          codex: '--model gpt-5'
        },
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })
    ).toBe('mixed')
  })

  it('resolves one Codex yolo launch as yolo', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'codex',
        agentArgs: YOLO_TUI_AGENT_ARGS.codex,
        agentEnv: {}
      })
    ).toBe('yolo')
  })

  it('resolves one empty Codex launch as manual', () => {
    expect(resolveTuiAgentPermissionMode({ agent: 'codex', agentArgs: '', agentEnv: {} })).toBe(
      'manual'
    )
  })

  it('resolves custom Codex permission arguments as mixed', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'codex',
        agentArgs: '--ask-for-approval on-request',
        agentEnv: {}
      })
    ).toBe('mixed')
  })

  it('resolves env-driven yolo launches', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'goose',
        agentArgs: '',
        agentEnv: YOLO_TUI_AGENT_ENV.goose
      })
    ).toBe('yolo')
  })

  describe('safe mode', () => {
    it('only lists agents with OS-enforced, args-expressible confinement', () => {
      // Why pinned: an entry here IS the claim "this agent cannot rm -rf outside the
      // workspace under safe mode." Growing the list requires verifying the real CLI.
      expect(Object.keys(SAFE_TUI_AGENT_ARGS).sort()).toEqual(['codex', 'gemini'])
      expect(agentSupportsConfinedLaunch('codex')).toBe(true)
      expect(agentSupportsConfinedLaunch('claude')).toBe(false)
      expect(agentSupportsConfinedLaunch('aider')).toBe(false)
    })

    it('keeps confinement and approvals as separate flags for codex', () => {
      expect(SAFE_TUI_AGENT_ARGS.codex).toBe('--sandbox workspace-write --ask-for-approval never')
      expect(SAFE_TUI_AGENT_ARGS.gemini).toBe('--sandbox --approval-mode yolo')
    })

    it('applies safe args to confinable agents and manual to the rest', () => {
      const result = applyAgentPermissionMode({
        mode: 'safe',
        agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })

      expect(result.agentDefaultArgs.codex).toBe(SAFE_TUI_AGENT_ARGS.codex)
      expect(result.agentDefaultArgs.gemini).toBe(SAFE_TUI_AGENT_ARGS.gemini)
      // Why '' and not the yolo string: no sandbox available means the agent's own
      // prompts stay on — prompts block, bypass destroys.
      expect(result.agentDefaultArgs.claude).toBe('')
      expect(result.agentDefaultArgs.aider).toBe('')
      expect(result.agentDefaultEnv.goose).toEqual({})
      // Why env too: gemini reads GEMINI_SANDBOX before the --sandbox flag and lets it win,
      // so safe must pin it or a shell export could silently disable the sandbox.
      expect(result.agentDefaultEnv.gemini).toEqual({ GEMINI_SANDBOX: 'true' })
    })

    it('never clobbers custom args when applying safe mode', () => {
      const result = applyAgentPermissionMode({
        mode: 'safe',
        agentDefaultArgs: { codex: '--model gpt-5' },
        agentDefaultEnv: {}
      })
      expect(result.agentDefaultArgs.codex).toBe('--model gpt-5')
    })

    it('round-trips safe back to yolo and manual', () => {
      const safe = applyAgentPermissionMode({
        mode: 'safe',
        agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })
      const backToYolo = applyAgentPermissionMode({
        mode: 'yolo',
        agentDefaultArgs: safe.agentDefaultArgs,
        agentDefaultEnv: safe.agentDefaultEnv
      })
      expect(backToYolo.agentDefaultArgs).toEqual({ ...YOLO_TUI_AGENT_ARGS })
      expect(backToYolo.agentDefaultEnv.goose).toEqual(YOLO_TUI_AGENT_ENV.goose)
      expect(backToYolo.agentDefaultEnv.gemini).toEqual({})

      const backToManual = applyAgentPermissionMode({
        mode: 'manual',
        agentDefaultArgs: safe.agentDefaultArgs,
        agentDefaultEnv: safe.agentDefaultEnv
      })
      expect(backToManual.agentDefaultArgs.codex).toBe('')
    })

    it('resolves gemini launches without env poisoning the combine', () => {
      // Safe: sandbox args + pinned env both read safe.
      expect(
        resolveTuiAgentPermissionMode({
          agent: 'gemini',
          agentArgs: SAFE_TUI_AGENT_ARGS.gemini,
          agentEnv: SAFE_TUI_AGENT_ENV.gemini
        })
      ).toBe('safe')
      // Yolo: empty env carries no signal for gemini and must not read as manual.
      expect(
        resolveTuiAgentPermissionMode({
          agent: 'gemini',
          agentArgs: YOLO_TUI_AGENT_ARGS.gemini,
          agentEnv: {}
        })
      ).toBe('yolo')
      // A hand-set env is a customization.
      expect(
        resolveTuiAgentPermissionMode({
          agent: 'gemini',
          agentArgs: SAFE_TUI_AGENT_ARGS.gemini,
          agentEnv: { GEMINI_SANDBOX: 'false' }
        })
      ).toBe('mixed')
    })

    it('resolves a safe codex launch as safe, not mixed', () => {
      expect(
        resolveTuiAgentPermissionMode({
          agent: 'codex',
          agentArgs: SAFE_TUI_AGENT_ARGS.codex,
          agentEnv: {}
        })
      ).toBe('safe')
    })

    it('summarizes a safe profile as safe despite unconfinable agents on manual', () => {
      const safe = applyAgentPermissionMode({
        mode: 'safe',
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
      expect(
        resolveAgentPermissionModeSummary({
          agentDefaultArgs: safe.agentDefaultArgs,
          agentDefaultEnv: safe.agentDefaultEnv
        })
      ).toBe('safe')
    })

    it('summarizes safe mixed with a yolo agent as mixed', () => {
      const safe = applyAgentPermissionMode({
        mode: 'safe',
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
      expect(
        resolveAgentPermissionModeSummary({
          agentDefaultArgs: { ...safe.agentDefaultArgs, claude: YOLO_TUI_AGENT_ARGS.claude },
          agentDefaultEnv: safe.agentDefaultEnv
        })
      ).toBe('mixed')
    })
  })
})

describe('getPresetAgentArgs', () => {
  it('returns the args each preset would restore, per agent', () => {
    expect(getPresetAgentArgs('codex', 'yolo')).toBe(YOLO_TUI_AGENT_ARGS.codex)
    expect(getPresetAgentArgs('codex', 'safe')).toBe(SAFE_TUI_AGENT_ARGS.codex)
    // Why '' matters: on a safe profile, Reset on an unconfinable agent must restore
    // "its own prompts", never quietly reinstall the bypass flag.
    expect(getPresetAgentArgs('claude', 'safe')).toBe('')
    expect(getPresetAgentArgs('claude', 'manual')).toBe('')
    expect(getPresetAgentArgs('claude', 'yolo')).toBe(YOLO_TUI_AGENT_ARGS.claude)
  })
})

describe('reconcileAgentProfileWithPreset', () => {
  it('fills agents missing from the profile with the stored preset, not the yolo default', () => {
    // Why: an agent added to the catalog after the user chose Safe has no stored entry and
    // would otherwise resolve to the built-in default — the bypass flag.
    const { agentDefaultArgs, agentDefaultEnv } = reconcileAgentProfileWithPreset('safe', {}, {})
    expect(agentDefaultArgs.codex).toBe(SAFE_TUI_AGENT_ARGS.codex)
    expect(agentDefaultArgs.claude).toBe('')
    expect(agentDefaultEnv.gemini).toEqual({ GEMINI_SANDBOX: 'true' })
    expect(agentDefaultEnv.goose).toEqual({})
  })

  it('never touches existing entries, including explicit empty strings', () => {
    const { agentDefaultArgs } = reconcileAgentProfileWithPreset(
      'safe',
      { codex: '--model gpt-5', claude: '' },
      {}
    )
    expect(agentDefaultArgs.codex).toBe('--model gpt-5')
    expect(agentDefaultArgs.claude).toBe('')
  })

  it('fills with yolo values under a stored yolo preset (legacy behavior preserved)', () => {
    const { agentDefaultArgs, agentDefaultEnv } = reconcileAgentProfileWithPreset('yolo', {}, {})
    expect(agentDefaultArgs.codex).toBe(YOLO_TUI_AGENT_ARGS.codex)
    expect(agentDefaultEnv.goose).toEqual(YOLO_TUI_AGENT_ENV.goose)
  })
})

describe('getPresetAgentEnv', () => {
  it('mirrors getPresetAgentArgs on the env axis', () => {
    expect(getPresetAgentEnv('goose', 'yolo')).toEqual({ GOOSE_MODE: 'auto' })
    expect(getPresetAgentEnv('goose', 'safe')).toEqual({})
    expect(getPresetAgentEnv('gemini', 'safe')).toEqual({ GEMINI_SANDBOX: 'true' })
    expect(getPresetAgentEnv('gemini', 'manual')).toEqual({})
  })
})
