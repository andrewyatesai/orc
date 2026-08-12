import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { outMainDirectory } from '../out-main-directory'
import {
  PortScanCommandClient,
  resolveWorkerEntryPath,
  type PortScanCommandResult,
  type WorkerEntryLayout
} from './port-scan-command-client'

// Why: resolve the built worker entry + own the process-wide shared client so
// the client class stays free of Electron (require'd lazily here) and the
// scanner call sites depend only on the routing function below. Mirrors
// session-scanner-opencode-sqlite-worker-spawn.ts.

export { isPortScanWorkerUnavailableError } from './port-scan-command-client'
export type { PortScanCommandResult } from './port-scan-command-client'

function currentWorkerEntryLayout(): WorkerEntryLayout {
  let app: { isPackaged: boolean } | null = null
  try {
    app = require('electron').app ?? null
  } catch {
    app = null
  }
  return {
    isPackaged: app?.isPackaged === true,
    resourcesPath: process.resourcesPath,
    moduleDir: outMainDirectory()
  }
}

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerEntryPath(currentWorkerEntryLayout())
  // Why: a missing built entry must throw synchronously so the client can fail
  // closed before it waits on a worker that can never post a result.
  if (!existsSync(workerPath)) {
    throw new Error(`Port scan command worker entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

let sharedClient: PortScanCommandClient | null = null

/**
 * Run a port-scan probe command through the process-wide worker client.
 * @param command - Executable name (lsof, ps, netstat, powershell.exe).
 * @param args - Argument vector passed verbatim to execFile.
 * @returns The command's stdout plus its measured process-creation latency.
 */
export function runPortScanCommand(
  command: string,
  args: string[]
): Promise<PortScanCommandResult> {
  sharedClient ??= new PortScanCommandClient({ workerFactory: defaultWorkerFactory })
  return sharedClient.run(command, args)
}
