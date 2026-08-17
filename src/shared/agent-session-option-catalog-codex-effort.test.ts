import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'

function codexEffortChoices(modelId: string): string[] {
  const effort = getAgentSessionOptionCatalog('codex')!
    .models.find((model) => model.id === modelId)
    ?.options.find((option) => option.id === 'effort')
  return effort?.kind.type === 'select' ? effort.kind.choices.map((choice) => choice.value) : []
}

describe('codex effort ceilings', () => {
  // Codex clamps values above a model's advertised ceiling, so the picker must
  // stop at each model's own top level — sol/terra reach ultra, luna caps at max.
  it.each([
    { model: 'gpt-5.6-sol', ceiling: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    {
      model: 'gpt-5.6-terra',
      ceiling: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    },
    { model: 'gpt-5.6-luna', ceiling: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    { model: 'gpt-5.5', ceiling: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
    { model: 'gpt-5.2-codex', ceiling: ['minimal', 'low', 'medium', 'high', 'xhigh'] }
  ])('offers exactly $model advertised levels', ({ model, ceiling }) => {
    expect(codexEffortChoices(model)).toEqual(ceiling)
  })

  it('withholds levels above each ceiling — the value Codex would clamp', () => {
    // Plant the violation: luna is max-capped, 5.5 is xhigh-capped.
    expect(codexEffortChoices('gpt-5.6-luna')).not.toContain('ultra')
    expect(codexEffortChoices('gpt-5.5')).not.toContain('max')
    expect(codexEffortChoices('gpt-5.5')).not.toContain('ultra')
  })

  it('keeps every model on the same conservative medium default', () => {
    for (const model of getAgentSessionOptionCatalog('codex')!.models) {
      const effort = model.options.find((option) => option.id === 'effort')
      expect(effort?.kind.type === 'select' ? effort.kind.defaultValue : undefined).toBe('medium')
    }
  })

  it('launches a within-ceiling effort as a reasoning-effort config flag', () => {
    expect(
      resolveAgentSessionOptionLaunch('codex', { model: 'gpt-5.6-sol', effort: 'ultra' })
    ).toEqual({
      args: ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=ultra'],
      appliedValues: { model: 'gpt-5.6-sol', effort: 'ultra' }
    })
  })
})
