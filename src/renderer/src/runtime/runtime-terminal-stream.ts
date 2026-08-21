import type { GlobalSettings } from '../../../shared/types'
import { RuntimeRpcCallError, getActiveRuntimeTarget } from './runtime-rpc-client'
import { getRemoteRuntimeTerminalMultiplexer } from './remote-runtime-terminal-multiplexer'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'

export {
  parseRemoteRuntimePtyId,
  toRemoteRuntimePtyId,
  type RemoteRuntimePtyIdParts
} from '../../../shared/remote-runtime-pty-id'

const LIVE_TAIL_SUBSCRIPTION_TIMEOUT_MS = 10_000

export function getRemoteRuntimeTerminalHandle(ptyId: string): string | null {
  return parseRemoteRuntimePtyId(ptyId)?.handle ?? null
}

export function getRemoteRuntimePtyEnvironmentId(ptyId: string): string | null {
  return parseRemoteRuntimePtyId(ptyId)?.environmentId ?? null
}

export function runtimeTerminalErrorMessage(error: unknown): string {
  if (error instanceof RuntimeRpcCallError) {
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export type RuntimeTerminalStreamEndReason = 'end' | 'transport-close'

export async function subscribeToRuntimeTerminalData(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  clientId: string,
  watcher: (data: string) => void,
  options?: {
    startAtLiveTail?: boolean
    /** Fires once the established stream dies: 'end' is the host's end frame
     *  (exit OR server-side cleanup — callers must classify, #9151), while
     *  'transport-close' is routine transport churn. */
    onStreamEnd?: (reason: RuntimeTerminalStreamEndReason) => void
  }
): Promise<() => void> {
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment' || !terminal) {
    return () => {}
  }

  let resolveLiveTail: (() => void) | null = null
  let rejectLiveTail: ((error: Error) => void) | null = null
  const liveTailReady = options?.startAtLiveTail
    ? new Promise<void>((resolve, reject) => {
        resolveLiveTail = resolve
        rejectLiveTail = reject
      })
    : null
  const rejectPendingLiveTail = (message: string): void => {
    rejectLiveTail?.(new Error(message))
    resolveLiveTail = null
    rejectLiveTail = null
  }

  const stream = await getRemoteRuntimeTerminalMultiplexer(target.environmentId).subscribeTerminal({
    terminal,
    client: { id: clientId, type: 'desktop' },
    callbacks: {
      onData: (data) => watcher(data),
      onSnapshot: (data) => {
        if (!options?.startAtLiveTail) {
          watcher(data)
        }
      },
      onSubscribed: () => {
        resolveLiveTail?.()
        resolveLiveTail = null
        rejectLiveTail = null
      },
      onEnd: () => {
        rejectPendingLiveTail('Remote terminal ended before live output was ready.')
        options?.onStreamEnd?.('end')
      },
      onError: (message) => rejectPendingLiveTail(message),
      onTransportClose: () => {
        rejectPendingLiveTail('Remote terminal closed before live output was ready.')
        options?.onStreamEnd?.('transport-close')
      }
    }
  })

  if (liveTailReady) {
    let timeout: ReturnType<typeof setTimeout> | null = setTimeout(
      () => rejectPendingLiveTail('Timed out waiting for remote terminal live output.'),
      LIVE_TAIL_SUBSCRIPTION_TIMEOUT_MS
    )
    try {
      // Why: outcome observers must ignore historical snapshots and be armed
      // before the command whose output they classify, including over SSH.
      await liveTailReady
    } catch (error) {
      stream.close()
      throw error
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout)
        timeout = null
      }
    }
  }

  return () => stream.close()
}
