import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalScrollbackTailReader,
  TERMINAL_SCROLLBACK_TAIL_PREFETCH_TTL_MS,
  type TerminalScrollbackTailRead
} from './terminal-scrollback-tail-prefetch'

function tail(text: string): TerminalScrollbackTailRead {
  return { text, olderChunkCursor: 0, olderEndOffset: 12, fingerprint: `${text.length}:7` }
}

type Harness = {
  reader: ReturnType<typeof createTerminalScrollbackTailReader>
  readTailSync: ReturnType<typeof vi.fn>
  resolvePrefetch: (payload: unknown) => Promise<void>
  rejectPrefetch: () => Promise<void>
  expiries: { run: () => void; delayMs: number }[]
  setNow: (value: number) => void
}

function harness(options: { diskTails?: Record<string, TerminalScrollbackTailRead> } = {}): Harness {
  const disk = options.diskTails ?? {}
  const readTailSync = vi.fn((args: { ref: string }) => disk[args.ref] ?? null)
  const expiries: { run: () => void; delayMs: number }[] = []
  let now = 1_000
  let settle: (payload: unknown) => void = () => {}
  let fail: () => void = () => {}
  const pending = new Promise<unknown>((resolve, reject) => {
    settle = resolve
    fail = () => reject(new Error('prefetch unavailable'))
  })

  const reader = createTerminalScrollbackTailReader({
    requestPrefetch: () => pending,
    readTailSync,
    now: () => now,
    scheduleExpiry: (run, delayMs) => expiries.push({ run, delayMs })
  })

  return {
    reader,
    readTailSync,
    resolvePrefetch: async (payload) => {
      settle(payload)
      await pending.catch(() => {})
      await Promise.resolve()
    },
    rejectPrefetch: async () => {
      fail()
      await pending.catch(() => {})
      await Promise.resolve()
    },
    expiries,
    setNow: (value) => {
      now = value
    }
  }
}

describe('createTerminalScrollbackTailReader', () => {
  it('serves prefetched bytes without touching the blocking sync read', async () => {
    // Both paths read the same snapshot through the same main-side Store call,
    // so the prefetch hit must be byte-identical to the sync answer.
    const bytes = tail('restored scrollback \u{1F980} café')
    const h = harness({ diskTails: { 'v1-a': bytes } })
    await h.resolvePrefetch({ 'v1-a': { ...bytes } })

    expect(h.reader.read({ ref: 'v1-a' })).toEqual(bytes)
    expect(h.readTailSync).not.toHaveBeenCalled()
  })

  it('falls back to the sync read for refs the prefetch did not cover', async () => {
    const h = harness({ diskTails: { 'v1-b': tail('only on disk') } })
    await h.resolvePrefetch({ 'v1-a': tail('prefetched') })

    expect(h.reader.read({ ref: 'v1-b' })?.text).toBe('only on disk')
    expect(h.readTailSync).toHaveBeenCalledWith({ ref: 'v1-b' })
  })

  it('falls back when the prefetch never resolves, and keeps that ref off the late payload', async () => {
    const bytes = tail('mounted first')
    const h = harness({ diskTails: { 'v1-a': bytes } })

    // Pane mounts before the prefetch lands: bytes come from the sync read, once.
    expect(h.reader.read({ ref: 'v1-a' })?.text).toBe('mounted first')
    expect(h.readTailSync).toHaveBeenCalledTimes(1)

    await h.resolvePrefetch({ 'v1-a': tail('stale duplicate') })
    // The late payload must not become a second delivery for that pane.
    expect(h.reader.cachedRefCount()).toBe(0)
    expect(h.reader.read({ ref: 'v1-a' })?.text).toBe('mounted first')
    expect(h.readTailSync).toHaveBeenCalledTimes(2)
  })

  it('drops each tail as it is consumed and expires the rest', async () => {
    const h = harness({ diskTails: { 'v1-a': tail('fresh disk read') } })
    await h.resolvePrefetch({ 'v1-a': tail('prefetched'), 'v1-b': tail('never read') })
    expect(h.reader.cachedRefCount()).toBe(2)

    expect(h.reader.read({ ref: 'v1-a' })?.text).toBe('prefetched')
    // Consumed entries are released immediately — a resident tail can be 512KB.
    expect(h.reader.cachedRefCount()).toBe(1)
    expect(h.reader.read({ ref: 'v1-a' })?.text).toBe('fresh disk read')

    expect(h.expiries).toHaveLength(1)
    expect(h.expiries[0].delayMs).toBe(TERMINAL_SCROLLBACK_TAIL_PREFETCH_TTL_MS)
    h.expiries[0].run()
    expect(h.reader.cachedRefCount()).toBe(0)
  })

  it('re-reads instead of replaying a tail that outlived the restore', async () => {
    const h = harness({ diskTails: { 'v1-a': tail('fresh disk read') } })
    await h.resolvePrefetch({ 'v1-a': tail('prefetched') })

    h.setNow(1_000 + TERMINAL_SCROLLBACK_TAIL_PREFETCH_TTL_MS + 1)
    expect(h.reader.read({ ref: 'v1-a' })?.text).toBe('fresh disk read')
    expect(h.reader.cachedRefCount()).toBe(0)
  })

  it('drops the prefetch when a session write may rewrite the snapshot files', async () => {
    const h = harness({ diskTails: { 'v1-a': tail('rewritten on disk') } })
    await h.resolvePrefetch({ 'v1-a': tail('prefetched') })

    // Ref-only writes are what a restore itself performs — they must not evict.
    h.reader.noteSessionWrite({
      terminalLayoutsByTabId: { 'tab-1': { scrollbackRefsByLeafId: { 'leaf-a': 'v1-a' } } }
    })
    expect(h.reader.cachedRefCount()).toBe(1)

    // A park/sleep/close capture carries buffers, so main rewrites the snapshot.
    h.reader.noteSessionWrite({
      terminalLayoutsByTabId: { 'tab-1': { buffersByLeafId: { 'leaf-a': 'fresh bytes' } } }
    })
    expect(h.reader.cachedRefCount()).toBe(0)
    expect(h.reader.read({ ref: 'v1-a' })?.text).toBe('rewritten on disk')
  })

  it('tolerates session writes with no layouts at all', async () => {
    const h = harness()
    await h.resolvePrefetch({ 'v1-a': tail('prefetched') })

    h.reader.noteSessionWrite(null)
    h.reader.noteSessionWrite({ terminalLayoutsByTabId: { 'tab-1': null } })
    expect(h.reader.cachedRefCount()).toBe(1)
  })

  it('keeps working when the prefetch rejects or returns junk', async () => {
    const rejected = harness({ diskTails: { 'v1-a': tail('disk') } })
    await rejected.rejectPrefetch()
    expect(rejected.reader.read({ ref: 'v1-a' })?.text).toBe('disk')

    const junk = harness({ diskTails: { 'v1-a': tail('disk') } })
    await junk.resolvePrefetch({ 'v1-a': { text: 'no offsets' } })
    expect(junk.reader.read({ ref: 'v1-a' })?.text).toBe('disk')
    expect(junk.reader.cachedRefCount()).toBe(0)
  })

  it('survives a prefetch request that throws synchronously', () => {
    const readTailSync = vi.fn(() => tail('disk'))
    const reader = createTerminalScrollbackTailReader({
      requestPrefetch: () => {
        throw new Error('no handler registered')
      },
      readTailSync
    })

    expect(reader.read({ ref: 'v1-a' })?.text).toBe('disk')
  })
})
