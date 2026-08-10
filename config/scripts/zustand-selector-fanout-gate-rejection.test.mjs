// @proves-gate-fires check:zustand-selector-fanout
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'vitest'
import { assertGateAccepts, assertGateRejects } from './assert-gate-rejects-violation.mjs'

// The coverage ledger keys a proven rejection on this basename, so the sandbox copy keeps it.
const GATE_SCRIPT = 'zustand-selector-fanout-benchmark.mjs'
const CHECK = ['--check']
const REAL_ZUSTAND = path.dirname(createRequire(import.meta.url).resolve('zustand/package.json'))

/**
 * A `zustand/vanilla` that still runs the real store underneath, so the only thing a
 * plant changes is the store behavior the benchmark exists to measure. The gate script
 * itself is copied byte-for-byte and never edited.
 */
function shadowModule({
  rewriteState = '(state) => state',
  wrapSubscribe = '(store) => store.subscribe'
}) {
  return `import { performance } from 'node:perf_hooks'
import { createStore as createRealStore } from 'real-zustand/vanilla'

const rewriteState = ${rewriteState}
const wrapSubscribe = ${wrapSubscribe}

export const createStore = (initializer) => {
  const store = createRealStore(initializer)
  return {
    ...store,
    subscribe: wrapSubscribe(store),
    setState: (partial) => {
      const next = typeof partial === 'function' ? partial(store.getState()) : partial
      store.setState(rewriteState({ ...store.getState(), ...next }), true)
    }
  }
}
`
}

/** Same shim, no regression: proves the shim is not what fails the gate below. */
const FAITHFUL = {}
/** The regression the gate names: an unrelated write hands unchanged slices a new identity. */
const IDENTITY_CHURN = {
  rewriteState: `(state) =>
  Object.fromEntries(
    Object.entries(state).map(([key, value]) => [
      key,
      value !== null && typeof value === 'object' ? { ...value } : value
    ])
  )`
}
/** The benchmark measuring nothing: subscribers registered, never notified. */
const DROPPED_SUBSCRIBERS = { wrapSubscribe: '() => () => () => {}' }
/** A write path that blows the per-write budget by a margin no scheduling noise closes. */
const SLOW_WRITE = {
  rewriteState: `(state) => {
  const until = performance.now() + 3
  while (performance.now() < until) {}
  return state
}`
}

const sandboxes = []
const restoreEnv = []

// The gate's documented knobs. assertGateRejects hands the child process.env through
// unchanged, so shrinking the workload for the timing plant has to happen here.
function useBenchEnv(values) {
  for (const [name, value] of Object.entries(values)) {
    restoreEnv.push([name, process.env[name]])
    process.env[name] = value
  }
}

// Never recursive-rm through the symlink — its target is the installed zustand.
async function clearModule(slot) {
  const entry = await lstat(slot).catch(() => null)
  if (!entry) {
    return
  }
  await (entry.isSymbolicLink() ? unlink(slot) : rm(slot, { recursive: true, force: true }))
}

async function createSandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-zustand-fanout-gate-')))
  sandboxes.push(root)
  const scriptDir = path.join(root, 'config', 'scripts')
  const modules = path.join(root, 'node_modules')
  const script = path.join(scriptDir, GATE_SCRIPT)
  await mkdir(scriptDir, { recursive: true })
  await mkdir(modules, { recursive: true })
  await copyFile(path.join(import.meta.dirname, GATE_SCRIPT), script)
  await symlink(REAL_ZUSTAND, path.join(modules, 'zustand'), 'junction')

  return {
    root,
    script,
    accepts: (args = CHECK) => assertGateAccepts({ script, args, cwd: root }),
    rejects: (violation, expectMessage) =>
      assertGateRejects({ script, args: CHECK, cwd: root, violation, expectMessage }),
    shadow: async (spec) => {
      const slot = path.join(modules, 'zustand')
      await clearModule(slot)
      await clearModule(path.join(modules, 'real-zustand'))
      await symlink(REAL_ZUSTAND, path.join(modules, 'real-zustand'), 'junction')
      await mkdir(slot, { recursive: true })
      await writeFile(
        path.join(slot, 'package.json'),
        `${JSON.stringify({ name: 'zustand', type: 'module', exports: { './vanilla': './vanilla.mjs' } }, null, 2)}\n`
      )
      await writeFile(path.join(slot, 'vanilla.mjs'), shadowModule(spec))
    }
  }
}

afterEach(async () => {
  for (const [name, value] of restoreEnv.splice(0).toReversed()) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('check:zustand-selector-fanout rejects the fan-out regressions it is supposed to catch', () => {
  it('fails when an unrelated write re-creates an unchanged slice', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()
    await sandbox.shadow(FAITHFUL)
    sandbox.accepts()

    await sandbox.shadow(IDENTITY_CHURN)

    sandbox.rejects(
      'a store that re-creates unchanged slices on every unrelated write',
      'unrelated writes changed a stable selector result.'
    )
  })

  it('fails when the fan-out it claims to measure never reaches a subscriber', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()
    await sandbox.shadow(FAITHFUL)
    sandbox.accepts()

    await sandbox.shadow(DROPPED_SUBSCRIBERS)

    sandbox.rejects(
      'subscriptions that are registered but never notified',
      'selector runs, observed 0; update the fan-out model.'
    )
  })

  it('fails when a write costs more than the budget --check enforces', async () => {
    const sandbox = await createSandbox()
    sandbox.accepts()
    useBenchEnv({
      ORCA_ZUSTAND_BENCH_SUBSCRIBERS: '8',
      ORCA_ZUSTAND_BENCH_WRITES: '8',
      ORCA_ZUSTAND_BENCH_MAX_MS_PER_WRITE: '1'
    })
    await sandbox.shadow(FAITHFUL)
    sandbox.accepts()

    await sandbox.shadow(SLOW_WRITE)

    // Same tree, no flag: the budget is only enforced the way package.json runs it.
    sandbox.accepts([])
    sandbox.rejects(
      'a 3 ms burn on every write',
      'exceeded 1.00 ms/write. Inspect selector work and store subscription growth.'
    )
  })
})
