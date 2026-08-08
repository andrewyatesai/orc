/**
 * `appMode.get` / `appMode.set` — the CLI's half of §3.5/§10.1.
 *
 * `appMode` is also added to `orca status --json` (see the status method). That
 * is the more important half and the easy one to skip: this is an
 * agent-orchestration IDE, so without it an agent can silently *change* the
 * human's product but cannot *observe* which mode it is running under.
 *
 * `set` refuses when a higher rung owns the choice rather than writing a value
 * that would be shadowed — a selector that silently does nothing is worse than
 * one that says why it cannot.
 */
import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { APP_MODE_OPTIONS, type AppModeId } from '../../../../shared/app-mode/app-mode-id'
import { isAppModeSelectionLocked } from '../../../../shared/app-mode/resolve-app-mode'

const MODE_IDS = APP_MODE_OPTIONS.map((option) => option.id) as [AppModeId, ...AppModeId[]]

const AppModeSetParams = z.object({
  mode: z.enum(MODE_IDS)
})

export const APP_MODE_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'appMode.get',
    params: z.object({}),
    handler: (_params, { runtime }) => {
      const resolution = runtime.getAppModeResolution()
      return {
        mode: {
          ...resolution,
          locked: isAppModeSelectionLocked(resolution.source),
          unrecognized: runtime.getUnrecognizedAppMode()
        }
      }
    }
  }),
  defineMethod({
    name: 'appMode.set',
    params: AppModeSetParams,
    handler: (params, { runtime }) => {
      const before = runtime.getAppModeResolution()
      if (isAppModeSelectionLocked(before.source)) {
        throw new Error(
          `the app mode is fixed by the ${before.source === 'env' ? 'ORCA_APP_MODE environment variable' : 'lock in app-mode.json'} and cannot be changed here`
        )
      }
      runtime.setAppMode(params.mode)
      const after = runtime.getAppModeResolution()
      return { mode: { ...after, locked: isAppModeSelectionLocked(after.source) } }
    }
  })
]
