import { describe, expect, it, vi } from 'vitest'
import { createPtyForegroundProcessReadCache } from './pty-foreground-process-read'

type Reader = { getForegroundProcess: (ptyId: string) => Promise<string | null> | string | null }

describe('createPtyForegroundProcessReadCache', () => {
  it('returns null without a controller and never touches the reader', () => {
    const cache = createPtyForegroundProcessReadCache<Reader>()
    expect(cache.read('pty-1', null)).toBeNull()
    expect(cache.size).toBe(0)
  })

  it('dedupes concurrent reads and drains to empty once they settle', async () => {
    const getForegroundProcess = vi.fn().mockResolvedValue('codex')
    const controller: Reader = { getForegroundProcess }
    const cache = createPtyForegroundProcessReadCache<Reader>()

    const first = cache.read('pty-1', controller)
    const second = cache.read('pty-1', controller)
    expect(cache.size).toBe(1)
    expect(getForegroundProcess).toHaveBeenCalledOnce()

    expect(await first).toEqual({ controller, process: 'codex', available: true })
    expect(await second).toEqual({ controller, process: 'codex', available: true })
    await vi.waitFor(() => expect(cache.size).toBe(0))
  })

  it('chains a fresh read when the pending one predates the requested observation', async () => {
    let resolveStale!: (process: string) => void
    const stale = new Promise<string>((resolve) => {
      resolveStale = resolve
    })
    const getForegroundProcess = vi.fn().mockReturnValueOnce(stale).mockResolvedValueOnce('zsh')
    const controller: Reader = { getForegroundProcess }
    const cache = createPtyForegroundProcessReadCache<Reader>()

    const earlyRead = cache.read('pty-1', controller, 1)
    const laterRead = cache.read('pty-1', controller, 2)
    expect(getForegroundProcess).toHaveBeenCalledOnce()

    resolveStale('codex')
    expect(await earlyRead).toEqual({ controller, process: 'codex', available: true })
    // The later observation must not trust the stale read; it gets a fresh probe.
    expect(await laterRead).toEqual({ controller, process: 'zsh', available: true })
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('reuses a pending read for an observation it already covers', async () => {
    const getForegroundProcess = vi.fn().mockResolvedValue('codex')
    const controller: Reader = { getForegroundProcess }
    const cache = createPtyForegroundProcessReadCache<Reader>()

    const started = cache.read('pty-1', controller, 5)
    const reused = cache.read('pty-1', controller, 3)
    expect(started).toBe(reused)
    expect(getForegroundProcess).toHaveBeenCalledOnce()
    await started
  })

  it('marks a synchronous throw as unavailable and shares the miss', async () => {
    const getForegroundProcess = vi.fn(() => {
      throw new TypeError('unavailable')
    })
    const controller: Reader = { getForegroundProcess }
    const cache = createPtyForegroundProcessReadCache<Reader>()

    const first = cache.read('pty-1', controller)
    const second = cache.read('pty-1', controller)
    expect(getForegroundProcess).toHaveBeenCalledOnce()
    expect(await first).toEqual({ controller, process: null, available: false })
    expect(await second).toEqual({ controller, process: null, available: false })
    await vi.waitFor(() => expect(cache.size).toBe(0))
  })

  it('marks a rejected probe as unavailable', async () => {
    const getForegroundProcess = vi.fn().mockRejectedValue(new Error('relay down'))
    const controller: Reader = { getForegroundProcess }
    const cache = createPtyForegroundProcessReadCache<Reader>()

    expect(await cache.read('pty-1', controller)).toEqual({
      controller,
      process: null,
      available: false
    })
  })

  it('does not reuse a read taken against a superseded controller', async () => {
    const controllerA: Reader = { getForegroundProcess: vi.fn().mockResolvedValue('codex') }
    const controllerB: Reader = { getForegroundProcess: vi.fn().mockResolvedValue('claude') }
    const cache = createPtyForegroundProcessReadCache<Reader>()

    const readA = cache.read('pty-1', controllerA)
    const readB = cache.read('pty-1', controllerB)
    expect(readA).not.toBe(readB)
    expect(await readA).toMatchObject({ controller: controllerA, process: 'codex' })
    expect(await readB).toMatchObject({ controller: controllerB, process: 'claude' })
  })
})
