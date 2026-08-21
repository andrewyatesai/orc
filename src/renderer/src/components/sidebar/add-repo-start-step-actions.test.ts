import { describe, expect, it, vi } from 'vitest'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { buildAddRepoStartStepActions } from './add-repo-start-step-actions'

function makeDeps(selectedHostId: 'runtime:paired' | null) {
  return {
    selectedHostId,
    selectedParsedHost: parseExecutionHostId('runtime:paired'),
    handleBrowse: vi.fn(),
    handleOpenRemoteStep: vi.fn(),
    setStep: vi.fn(),
    setCloneError: vi.fn(),
    setCreateError: vi.fn()
  }
}

describe('buildAddRepoStartStepActions', () => {
  it('routes browse through the paired runtime and opens the server-path step', () => {
    const deps = makeDeps('runtime:paired')

    buildAddRepoStartStepActions(deps).onBrowse()

    expect(deps.setStep).toHaveBeenCalledWith('server-path')
    expect(deps.handleBrowse).not.toHaveBeenCalled()
  })

  it('gates clone and create entry while no host is selectable', () => {
    const deps = makeDeps(null)
    const actions = buildAddRepoStartStepActions(deps)

    actions.onOpenCloneStep()
    actions.onOpenCreateStep()

    expect(deps.setStep).not.toHaveBeenCalled()
    expect(deps.setCloneError).not.toHaveBeenCalled()
    expect(deps.setCreateError).not.toHaveBeenCalled()
  })

  it('enters clone and create steps once a host is selectable', () => {
    const deps = makeDeps('runtime:paired')
    const actions = buildAddRepoStartStepActions(deps)

    actions.onOpenCloneStep()
    actions.onOpenCreateStep()

    expect(deps.setCloneError).toHaveBeenCalledWith(null)
    expect(deps.setCreateError).toHaveBeenCalledWith(null)
    expect(deps.setStep).toHaveBeenCalledWith('clone')
    expect(deps.setStep).toHaveBeenCalledWith('create')
  })
})
