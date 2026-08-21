import type { Dispatch, SetStateAction } from 'react'
import type { ExecutionHostId, ParsedExecutionHost } from '../../../../shared/execution-host'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { routeAddRepoBrowse } from './add-repo-browse-authority'

export type AddRepoStartStepActionDeps = {
  selectedHostId: ExecutionHostId | null
  selectedParsedHost: ParsedExecutionHost | null
  handleBrowse: () => void
  handleOpenRemoteStep: (targetId: string) => void
  setStep: Dispatch<SetStateAction<AddRepoDialogStep>>
  setCloneError: Dispatch<SetStateAction<string | null>>
  setCreateError: Dispatch<SetStateAction<string | null>>
}

export type AddRepoStartStepActions = {
  onBrowse: () => void
  onOpenCloneStep: () => void
  onOpenCreateStep: () => void
}

// Routes the Add Project start-step buttons by host, and gates clone/create entry
// until a filesystem authority is selectable (paired web has none while loading).
export function buildAddRepoStartStepActions({
  selectedHostId,
  selectedParsedHost,
  handleBrowse,
  handleOpenRemoteStep,
  setStep,
  setCloneError,
  setCreateError
}: AddRepoStartStepActionDeps): AddRepoStartStepActions {
  return {
    onBrowse: () =>
      routeAddRepoBrowse(selectedParsedHost, {
        browseLocal: handleBrowse,
        browseRuntime: () => setStep('server-path'),
        browseSsh: handleOpenRemoteStep
      }),
    onOpenCloneStep: () => {
      if (!selectedHostId) {
        return
      }
      setCloneError(null)
      setStep('clone')
    },
    onOpenCreateStep: () => {
      if (!selectedHostId) {
        return
      }
      setCreateError(null)
      setStep('create')
    }
  }
}
