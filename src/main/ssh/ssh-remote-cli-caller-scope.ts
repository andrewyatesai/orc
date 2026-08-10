// Why: the SSH bridge runs the real host CLI as a separate process, so the
// caller's host bound cannot ride the passthrough's call stack into the
// resolvers. It rides an auth token instead: this module mints one per
// invocation and plants the runtime metadata the subprocess reads it from.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import {
  registerScopedCallerToken,
  UNATTRIBUTED_CALLER_SCOPE,
  type RuntimeCallerScope
} from '../runtime/runtime-caller-scope'

export function resolveRemoteCallerScope(request: { connectionId?: string }): RuntimeCallerScope {
  // Why: the session id is the only owner claim the remote account cannot write.
  return request.connectionId
    ? { kind: 'ssh', connectionId: request.connectionId }
    : UNATTRIBUTED_CALLER_SCOPE
}

export type ScopedCallerMetadata = {
  /** Directory the subprocess reads runtime metadata from (ORCA_USER_DATA_PATH). */
  userDataPath: string
  dispose: () => void
}

/**
 * Hands the CLI subprocess its own auth token instead of the runtime's shared
 * one, by planting a runtime-metadata file that points at the same transport.
 * The runtime maps that token back to this caller's scope, which is what lets a
 * resolver several processes away still know which host asked.
 */
export function createScopedCallerMetadataDir(
  scope: RuntimeCallerScope,
  hostUserDataPath: string
): ScopedCallerMetadata {
  const metadata = JSON.parse(
    readFileSync(getRuntimeMetadataPath(hostUserDataPath), 'utf8')
  ) as RuntimeMetadata | null
  if (!metadata || !Array.isArray(metadata.transports) || metadata.transports.length === 0) {
    throw new Error(`Orca runtime metadata is incomplete at ${hostUserDataPath}`)
  }
  const scoped = registerScopedCallerToken(scope)
  const dir = mkdtempSync(join(tmpdir(), 'orca-ssh-cli-'))
  try {
    writeFileSync(
      getRuntimeMetadataPath(dir),
      JSON.stringify({ ...metadata, authToken: scoped.token }),
      { mode: 0o600 }
    )
  } catch (err) {
    scoped.dispose()
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
  return {
    userDataPath: dir,
    dispose: () => {
      scoped.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
