// What the twin still owns after the cut-over: the attempt-id entropy edge.
// The payload logic moved to nested-repo-telemetry-payloads.test.ts, which runs
// the same cases against the Rust core.
import { describe, expect, it } from 'vitest'
import { createNestedRepoTelemetryAttemptId } from './nested-repo-telemetry'

describe('nested repo telemetry attempt ids', () => {
  it('generates non-persistent random attempt ids', () => {
    const first = createNestedRepoTelemetryAttemptId()
    const second = createNestedRepoTelemetryAttemptId()

    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(second).not.toBe(first)
  })
})
