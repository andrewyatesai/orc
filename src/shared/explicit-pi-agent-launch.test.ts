import { describe, expect, it } from 'vitest'
import { detectExplicitPiAgentKindFromCommand } from './explicit-pi-agent-launch'

describe('detectExplicitPiAgentKindFromCommand', () => {
  it('identifies explicit Pi and OMP launches', () => {
    expect(detectExplicitPiAgentKindFromCommand('pi --resume')).toBe('pi')
    expect(detectExplicitPiAgentKindFromCommand('/usr/local/bin/omp.sh')).toBe('omp')
    expect(detectExplicitPiAgentKindFromCommand('PI.CMD')).toBe('pi')
    expect(detectExplicitPiAgentKindFromCommand('~/bin/pi')).toBe('pi')
  })

  it('does not classify bare shells or other agents as Pi launches', () => {
    expect(detectExplicitPiAgentKindFromCommand(undefined)).toBeNull()
    expect(detectExplicitPiAgentKindFromCommand('')).toBeNull()
    expect(detectExplicitPiAgentKindFromCommand('codex --resume session-a')).toBeNull()
    expect(detectExplicitPiAgentKindFromCommand('codex "ask about pi"')).toBeNull()
    expect(detectExplicitPiAgentKindFromCommand('claude')).toBeNull()
    expect(detectExplicitPiAgentKindFromCommand('python3 script.py')).toBeNull()
    expect(detectExplicitPiAgentKindFromCommand('pip install foo')).toBeNull()
  })

  it('classifies the launched agent instead of mentions in its arguments', () => {
    expect(detectExplicitPiAgentKindFromCommand('pi "compare omp"')).toBe('pi')
    expect(detectExplicitPiAgentKindFromCommand('omp "compare pi"')).toBe('omp')
  })
})
