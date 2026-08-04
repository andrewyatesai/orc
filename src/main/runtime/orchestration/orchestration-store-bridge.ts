import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import {
  requireRustGitBinding,
  type RustOrchestrationStoreHandle
} from '../../daemon/rust-git-addon'
import { OrchestrationError } from './orchestration-error'
import type { MessageType } from './types'

// Ids stay `<prefix>_<hex>` (the shim owns generation, not Rust): orca-runtime.ts
// extracts task ids with `/task_[A-Za-z0-9]+/`, so the format is a contract.
export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

// Why: the store treats an empty filter as "no filter"; normalize before crossing napi.
export function typesFilter(types?: MessageType[]): MessageType[] | undefined {
  return types && types.length > 0 ? types : undefined
}

// Why: `undefined` keys vanish from JSON, which is exactly how the Rust builders
// read an absent optional field — so params objects marshal verbatim.
export function paramsJson(params: object): string {
  return JSON.stringify(params)
}

type OrchestrationErrorEnvelope = {
  _orcaOrchestrationError: true
  code: string
  message: string
  data?: unknown
}

// The Rust store serializes OrchestrationError into the napi `Error.message` as
// a JSON envelope; restore the coded error so callers keep branching on `.code`.
function restoreCodedError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(error.message)
  } catch {
    return error
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as OrchestrationErrorEnvelope)._orcaOrchestrationError !== true
  ) {
    return error
  }
  const envelope = parsed as OrchestrationErrorEnvelope
  return new OrchestrationError(envelope.code, envelope.message, envelope.data ?? undefined)
}

// Why a Proxy rather than 130 hand-written try/catch sites: the coded-error
// contract must hold for EVERY store method, and a wrapper that has to be
// remembered per call site is one that eventually is not.
function codedErrorBoundary(store: RustOrchestrationStoreHandle): RustOrchestrationStoreHandle {
  const wrapped = new Map<string | symbol, unknown>()
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if (typeof value !== 'function') {
        return value
      }
      const cached = wrapped.get(property)
      if (cached) {
        return cached
      }
      const call = value as (...args: unknown[]) => unknown
      const guard = (...args: unknown[]): unknown => {
        try {
          return call.apply(target, args)
        } catch (error) {
          throw restoreCodedError(error)
        }
      }
      wrapped.set(property, guard)
      return guard
    }
  }) as RustOrchestrationStoreHandle
}

function hardenOrchestrationDatabaseFiles(dbPath: string | ':memory:'): void {
  if (dbPath === ':memory:' || process.platform === 'win32') {
    // Why: Windows protects these files through Orca's current-user-only userData DACL; POSIX mode bits are inert there.
    return
  }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) {
      chmodSync(path, 0o600)
    }
  }
}

/**
 * The napi seam every `OrchestrationDb` domain builds on. The `node:sqlite`
 * twin — schema, migrations, every query — is deleted; `orca_runtime`'s
 * `OrchestrationDb` is the sole implementation and this class is a thin
 * delegating shim over its `OrchestrationStore` napi class.
 *
 * The shim keeps only the JS-side nondeterminism Rust must NOT own, so the
 * bytes stay identical to the deleted TS store: generated ids, the ISO
 * completion stamps, the UTF-16-aware display derivation, and the RFC3339
 * exposure of the four row types db.ts exposes (see db-row-timestamp-exposure.ts).
 * Everything else marshals through JSON — the store serializes each row to its
 * TS Row shape. Row-returning getters map the store's `null` (absent row) back
 * to `undefined` to preserve the old return contract.
 */
export class OrchestrationStoreBridge {
  protected store: RustOrchestrationStoreHandle

  // Why: buildAgentOrchestrationByPaneKey rebuilds context on every 16ms graph
  // publish, issuing ~2 napi dispatch lookups per terminal. The overwhelming
  // majority never orchestrate, so cache "any dispatch rows exist?" to let the
  // builder short-circuit the whole fan-out (#9694). createDispatchContext flips
  // it true; resets clear it back to a cold re-derive.
  protected hasAnyDispatchContextsCache: boolean | undefined

  constructor(dbPath: string | ':memory:') {
    // Lazy-require so merely importing this module never forces the native addon
    // to load — only an actual store instantiation depends on it.
    this.store = codedErrorBoundary(new (requireRustGitBinding().OrchestrationStore)(dbPath))
    hardenOrchestrationDatabaseFiles(dbPath)
  }

  resetAll(): void {
    this.store.resetAll()
    this.hasAnyDispatchContextsCache = undefined
  }

  resetTasks(): void {
    this.store.resetTasks()
    this.hasAnyDispatchContextsCache = undefined
  }

  resetMessages(): void {
    this.store.resetMessages()
  }

  close(): void {
    this.store.close()
  }
}
