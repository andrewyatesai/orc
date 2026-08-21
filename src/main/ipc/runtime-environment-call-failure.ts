import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../shared/runtime-rpc-call-queue'
import type { RuntimeRpcFailure } from '../../shared/runtime-rpc-envelope'

// Why: Electron's ipcMain.handle strips a thrown error's structured `code`,
// leaving only the message. The renderer then classifies transport failures by
// matching English message substrings, so a code-carrying rejection (queue
// overload, connection loss) can escape the recoverable list and surface as a
// raw error wall. Convert typed client/queue rejections into the structured
// {ok:false, error:{code,message}} envelope the preload passes through unchanged
// and unwrapRuntimeRpcResult reconstructs with the code intact (#12667).
export function runtimeEnvironmentCallFailure(
  method: string,
  error: unknown
): RuntimeRpcFailure | null {
  if (
    !(error instanceof RemoteRuntimeClientError) &&
    !(error instanceof RuntimeRpcCallQueueOverloadError)
  ) {
    return null
  }
  return {
    id: method,
    ok: false,
    error: { code: error.code, message: error.message },
    // Why: no runtime produced this response — it is a client-local transport
    // or queue rejection — so the runtimeId is honestly null.
    _meta: { runtimeId: null }
  }
}
