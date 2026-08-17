import {
  ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
  type EditorPrepareHotExitDetail
} from '../shared/editor-save-events'
import { ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT } from '../shared/renderer-shutdown-events'
import type { UpdateStatus } from '../shared/types'

export type AppRestartPrepOptions = {
  startedEventName: string
  abortedEventName: string
}

function requestEditorHotExitBackup(eventTarget: EventTarget): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let claimed = false
    eventTarget.dispatchEvent(
      new CustomEvent<EditorPrepareHotExitDetail>(ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT, {
        detail: {
          claim: () => {
            claimed = true
          },
          resolve,
          reject: (message) => {
            reject(new Error(message))
          }
        }
      })
    )

    // Why: restart paths can run before the editor autosave controller mounts.
    // With no claimant, there are no renderer-owned dirty buffers to back up.
    if (!claimed) {
      resolve()
    }
  })
}

export async function prepareRendererForAppRestart(
  eventTarget: EventTarget,
  { startedEventName, abortedEventName }: AppRestartPrepOptions
): Promise<void> {
  eventTarget.dispatchEvent(new Event(startedEventName))

  try {
    await requestEditorHotExitBackup(eventTarget)
    // Why: update installs can bypass native close. A cancelable synthetic
    // unload both captures mounted terminals and reports checkpoint failure.
    let checkpointFailed = false
    const markCheckpointFailed = (): void => {
      checkpointFailed = true
    }
    eventTarget.addEventListener(
      ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT,
      markCheckpointFailed
    )
    try {
      // Why: the aggregate unload verdict also includes unrelated listeners
      // (dirty-file vetoes, paired-web reload guards); only the checkpoint's own
      // failure event should abort the restart.
      eventTarget.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    } finally {
      eventTarget.removeEventListener(
        ORCA_RENDERER_SHUTDOWN_CHECKPOINT_FAILED_EVENT,
        markCheckpointFailed
      )
    }
    if (checkpointFailed) {
      throw new Error('Renderer shutdown checkpoint was not completed.')
    }
  } catch (error) {
    eventTarget.dispatchEvent(new Event(abortedEventName))
    throw error
  }
}

// Why: single checkpoint-then-invoke gate so relaunch/restart/reload can't skip the durable before-unload flush.
export async function prepareAndInvokeAppRestart(
  eventTarget: EventTarget,
  invoke: () => Promise<unknown>,
  options: AppRestartPrepOptions
): Promise<void> {
  await prepareRendererForAppRestart(eventTarget, options)
  try {
    await invoke()
  } catch (error) {
    eventTarget.dispatchEvent(new Event(options.abortedEventName))
    throw error
  }
}

export type UpdaterQuitAbortRelay = {
  markPrepared: () => void
  abort: () => void
  handleStatus: (status: UpdateStatus) => void
}

export function createUpdaterQuitAbortRelay(
  eventTarget: EventTarget,
  abortedEventName: string
): UpdaterQuitAbortRelay {
  let prepared = false
  const abort = (): void => {
    if (!prepared) {
      return
    }
    prepared = false
    eventTarget.dispatchEvent(new Event(abortedEventName))
  }

  return {
    markPrepared(): void {
      prepared = true
    },
    abort,
    handleStatus(status): void {
      // Why: quitAndInstall IPC resolves after scheduling; a later updater
      // error is the authoritative signal that the app will remain open.
      if (status.state === 'error') {
        abort()
      }
    }
  }
}
