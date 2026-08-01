import { describe, expect, it, vi } from 'vitest'

// Regression pin for the keystroke break introduced by 36bb9a7926 and fixed in
// aterm-worker-loader: a worker-backed term has no `term.encode_key`, so every
// keystroke routes through the MAIN-THREAD CPU glue, which throws until
// loadAterm() registers it. That commit removed the worker path's only
// loadAterm() call, leaving the idle prewarm as the sole loader — and the
// prewarm is skipped under e2e and cancelled once a real pane acquires. No test
// caught it because none of them type.
const loadAterm = vi.hoisted(() => vi.fn(() => Promise.resolve({})))
vi.mock('./load-aterm', () => ({ loadAterm }))

describe('worker-path CPU glue load', () => {
  it('the worker loader kicks loadAterm so the key encoder has its glue', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./aterm-worker-loader.ts', import.meta.url).pathname, 'utf8')
    )
    expect(source).toContain('void loadAterm()')
  })

  it('is NOT awaited — awaiting restores the dependency 36bb9a7926 removed', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./aterm-worker-loader.ts', import.meta.url).pathname, 'utf8')
    )
    expect(source).not.toContain('await loadAterm()')
  })

  it('the encoder really does throw without a registered glue (the failure being prevented)', async () => {
    vi.resetModules()
    const { atermCpuGlue } = await import('./aterm-wasm-module-registry')
    expect(() => atermCpuGlue()).toThrow(/not loaded/i)
  })
})
