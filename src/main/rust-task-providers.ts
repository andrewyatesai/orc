// Main-process task-provider normalizers, driven by the Rust task-providers
// core via napi (the shared TS impl was gutted to types + data). One source of
// truth with the parity-proven Rust port; main only consumes the guard and the
// settings normalizer, so those are the sole exports here.
import { dispatchToRustCore } from './rust-core-dispatch'
import type { TaskProvider } from '../shared/task-providers'

// Why 'omit': the settings normalizer's two fields are `unknown` off persisted
// settings, where an unset provider arrives as undefined and means "not stored".
function dispatch(fn: string, input: unknown): unknown {
  return dispatchToRustCore('task-providers', fn, input, { undefinedProperties: 'omit' })
}

export function isTaskProvider(value: unknown): value is TaskProvider {
  return dispatch('isTaskProvider', value) as boolean
}

export function normalizeTaskProviderSettings(value: {
  visibleTaskProviders: unknown
  defaultTaskSource: unknown
}): { visibleTaskProviders: TaskProvider[]; defaultTaskSource: TaskProvider } {
  return dispatch('normalizeTaskProviderSettings', value) as {
    visibleTaskProviders: TaskProvider[]
    defaultTaskSource: TaskProvider
  }
}
