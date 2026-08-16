// The cutover put `normalizeRepoSourceControlAiOverrides` on the Rust core behind
// the shared dispatch seam, and the two sides of that seam emit different KEY
// ORDER for the same value. The repository Source Control AI pane skips redundant
// repo writes by comparing a re-normalized `next` against the persisted `base` —
// two values that can be produced on opposite sides of the seam, because the
// renderer's binding only arrives when wasm is ready.
//
// These tests plant that mixed case. The first FAILS on a raw
// `JSON.stringify(next) === JSON.stringify(base)`, which is what both call sites
// used to do; the rest pin that the dedupe still fires and still lets a real
// change through.
import { describe, expect, it, vi } from 'vitest'
import { orcaDispatch } from '../../../../relay/wasm/orca_git_wasm.js'
import { setOrcaDispatchBinding, type OrcaDispatchFn } from '../../../../shared/orca-dispatch-seam'
import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control-ai'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import { createRepoAiPersistQueue } from './repository-source-control-ai-persist-queue'
import { sameRepoSourceControlAiOverrides } from './repository-source-control-ai-write-dedupe'

const wasmBinding: OrcaDispatchFn = (module, fn, inputJson) => orcaDispatch(module, fn, inputJson)

// Two action overrides, because the ordering difference is inside `actionOverrides`:
// a `pullRequest` recipe minted from the legacy instruction plus an explicit one.
const OVERRIDES = {
  enabled: true,
  customAgentCommand: 'run',
  instructionsByOperation: { pullRequest: 'p' },
  actionOverrides: { fixChecks: { agentId: 'codex', agentArgs: '-y' } },
  prCreationDefaults: { draft: true }
} as unknown as RepoSourceControlAiOverrides

function normalizeUnbound(value: RepoSourceControlAiOverrides): RepoSourceControlAiOverrides {
  setOrcaDispatchBinding(null)
  try {
    return normalizeRepoSourceControlAiOverrides(value) ?? {}
  } finally {
    setOrcaDispatchBinding(wasmBinding)
  }
}

function normalizeBound(value: RepoSourceControlAiOverrides): RepoSourceControlAiOverrides {
  setOrcaDispatchBinding(wasmBinding)
  return normalizeRepoSourceControlAiOverrides(value) ?? {}
}

describe('repo Source Control AI write dedupe across the dispatch seam', () => {
  it('the two sides of the seam really do disagree on key order', () => {
    // The premise. If this ever stops being true the guards below go quiet, so
    // assert it rather than assume it.
    const unbound = normalizeUnbound(OVERRIDES)
    const bound = normalizeBound(OVERRIDES)
    expect(JSON.stringify(unbound)).not.toBe(JSON.stringify(bound))
    expect(unbound).toEqual(bound)
  })

  it('sameRepoSourceControlAiOverrides sees them as the same write', () => {
    expect(
      sameRepoSourceControlAiOverrides(normalizeBound(OVERRIDES), normalizeUnbound(OVERRIDES))
    ).toBe(true)
  })

  it('a real change is still a change', () => {
    const changed = normalizeBound({
      ...OVERRIDES,
      customAgentCommand: 'run --different'
    } as RepoSourceControlAiOverrides)
    expect(sameRepoSourceControlAiOverrides(changed, normalizeUnbound(OVERRIDES))).toBe(false)
  })

  it('the persist queue skips the write when only the seam side changed', async () => {
    // The reachable sequence: the pane normalized its base before wasm was ready,
    // then a `withRepoAi*` transform re-normalizes on the bound seam.
    const persisted = normalizeUnbound(OVERRIDES)
    const updateRepo = vi.fn(async () => true)
    const queue = createRepoAiPersistQueue({
      getRepoId: () => 'repo-1',
      getPersisted: () => persisted,
      setPersisted: () => undefined,
      updateRepo,
      isMounted: () => true,
      onError: () => undefined
    })
    const ok = await queue.persistTransform((base) => normalizeBound(base))
    expect(ok).toBe(true)
    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('the persist queue still writes when the value actually changed', async () => {
    const persisted = normalizeUnbound(OVERRIDES)
    const updateRepo = vi.fn(async () => true)
    const queue = createRepoAiPersistQueue({
      getRepoId: () => 'repo-1',
      getPersisted: () => persisted,
      setPersisted: () => undefined,
      updateRepo,
      isMounted: () => true,
      onError: () => undefined
    })
    const ok = await queue.persistTransform((base) =>
      normalizeBound({ ...base, enabled: false } as RepoSourceControlAiOverrides)
    )
    expect(ok).toBe(true)
    expect(updateRepo).toHaveBeenCalledTimes(1)
  })
})
