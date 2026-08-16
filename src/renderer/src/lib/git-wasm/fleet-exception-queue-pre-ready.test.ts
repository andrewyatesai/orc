// Deliberately does NOT import './init-git-wasm-for-test' at the top: this file
// exists to observe the shim BEFORE the core is ready, which for this module is
// the state a supervisor would be lied to in.
//
// The contract declared in the shim header is `parity`, and parity is only
// honest if it holds for EVERY input, so this compares the two states over the
// adversarial corpus rather than over a couple of happy rows.
import { describe, expect, it } from 'vitest'
import { collapseExceptionsByTask, unwiredExceptionSources } from './fleet-exception-queue'
import { getGitWasmAvailability } from './git-wasm-availability'
import {
  EXCEPTION_SEVERITY,
  type FleetException,
  type FleetExceptionKind
} from '../../components/alab/fleet-exceptions'

const KINDS = Object.keys(EXCEPTION_SEVERITY) as FleetExceptionKind[]

function exception(overrides: Partial<FleetException> = {}): FleetException {
  return {
    taskId: 'task-1',
    kind: 'escalation',
    summary: 'something',
    workerHandle: 'w1',
    attempts: 1,
    at: '2026-08-07T10:00:00Z',
    ...overrides
  }
}

/** An open gate plus the retry storm around it — the batch whose collapse a
 *  wrong pre-ready value would erase. */
const openGate: FleetException[] = [
  exception({ taskId: 'stuck', kind: 'escalation', at: '2026-08-07T10:00:00Z' }),
  exception({ taskId: 'stuck', kind: 'escalation', at: '2026-08-07T10:00:03Z' }),
  exception({ taskId: 'stuck', kind: 'circuit-broken', at: '2026-08-07T10:00:09Z' }),
  exception({ taskId: 'asked', kind: 'gate', summary: 'Deploy to prod?', at: '2026-08-07T09:00:00Z' })
]

/** Sequences over every (kind, timestamp) template plus the string classes the
 *  differential found interesting: astral `at`s, an ignorable, empty fields. */
function corpus(): FleetException[][] {
  const templates: FleetException[] = []
  for (const kind of KINDS) {
    for (const at of ['2026-08-07T10:00:00Z', '2026-08-07T09:00:00Z']) {
      templates.push(exception({ kind, at, summary: `${kind}@${at}` }))
    }
  }
  const batches: FleetException[][] = [[], openGate]
  for (const left of templates) {
    batches.push([left])
    for (const right of templates) {
      batches.push([left, right])
      batches.push([{ ...left, taskId: 'a' }, { ...right, taskId: 'b' }])
      batches.push([{ ...left, taskId: 'b' }, { ...right, taskId: 'a' }])
    }
  }
  for (const at of ['', '10:00\u{10000}', '10:00', '10:00­', '10:00﻿']) {
    batches.push([exception({ at }), exception({ at: '10:00' })])
  }
  batches.push([exception({ taskId: '', summary: '', workerHandle: null, attempts: 0 })])
  batches.push([exception({ taskId: 'café' }), exception({ taskId: 'café' })])
  batches.push([exception({ attempts: -3 }), exception({ attempts: 9007199254740990 })])
  return batches
}

describe('collapseExceptionsByTask pre-ready value', () => {
  it('never answers [] for a batch that holds an exception', () => {
    expect(getGitWasmAvailability()).toBe('pending')
    // [] is the one value that must never come back here: ExceptionsQueue prints
    // "Nothing is waiting on you." for an empty list on a successful poll, so an
    // empty answer tells a supervisor the fleet is clear while a gate is open.
    const collapsed = collapseExceptionsByTask(openGate)
    expect(collapsed.map((row) => row.taskId)).toEqual(['asked', 'stuck'])
    expect(collapsed[1].attempts).toBe(3)
  })

  it('is not a plausible constant either — the answer follows the input', () => {
    expect(collapseExceptionsByTask([])).toEqual([])
    expect(collapseExceptionsByTask([exception({ kind: 'attention' })])[0].kind).toBe('attention')
  })

  it('reports the unwired sources from the table the twin still holds', () => {
    expect(unwiredExceptionSources()).toEqual([])
  })

  it('equals the ready core on every batch in the corpus', async () => {
    const batches = corpus()
    const preReady = batches.map((batch) => collapseExceptionsByTask(batch))
    const preReadyUnwired = unwiredExceptionSources()

    await import('./init-git-wasm-for-test')
    expect(getGitWasmAvailability()).toBe('ready')

    // Proves the corpus is discriminating: a fallback that answered [] would
    // have matched a core that also answered [] on an empty batch alone.
    expect(preReady.some((rows) => rows.length > 1)).toBe(true)
    for (const [index, batch] of batches.entries()) {
      expect(collapseExceptionsByTask(batch)).toEqual(preReady[index])
    }
    expect(unwiredExceptionSources()).toEqual(preReadyUnwired)
  })
})
