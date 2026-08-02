// Read-path refusals: a session Orca can name but cannot open must say which of
// "not written yet" and "read failed" happened, and never return an empty
// transcript that reads as "the agent said nothing".
import { describe, expect, it, vi } from 'vitest'
import {
  readAgentTranscriptForSource,
  type ReadableAgentTranscriptSource
} from './agent-transcript-read'

const SOURCE: ReadableAgentTranscriptSource = {
  readable: true,
  agent: 'claude',
  agentName: 'claude',
  sessionId: 'sess-1',
  filePath: null,
  transcriptPathHint: '/home/u/.claude/projects/p/sess-1.jsonl',
  host: { kind: 'local' }
}

function readers(
  over: Partial<Parameters<typeof readAgentTranscriptForSource>[0]['readers']> = {}
) {
  return {
    resolvePath: vi.fn().mockResolvedValue('/home/u/.claude/projects/p/sess-1.jsonl'),
    readTail: vi.fn().mockResolvedValue({ messages: [], hasMore: false, beforeOffset: 0 }),
    ...over
  }
}

describe('readAgentTranscriptForSource', () => {
  it('prefers the hook-reported path when resolving the file', async () => {
    const injected = readers()
    await readAgentTranscriptForSource({ handle: 't-1', source: SOURCE, readers: injected })
    expect(injected.resolvePath).toHaveBeenCalledWith('claude', 'sess-1', {
      transcriptPath: '/home/u/.claude/projects/p/sess-1.jsonl'
    })
  })

  it('skips resolution entirely for an already-exact file (the bridged WSL path)', async () => {
    const injected = readers()
    await readAgentTranscriptForSource({
      handle: 't-1',
      source: { ...SOURCE, filePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\s.jsonl' },
      readers: injected
    })
    expect(injected.resolvePath).not.toHaveBeenCalled()
    expect(injected.readTail).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\s.jsonl' })
    )
  })

  it('bounds the tail read and forwards the paging offset', async () => {
    const injected = readers()
    await readAgentTranscriptForSource({
      handle: 't-1',
      source: SOURCE,
      limit: 100_000,
      before: 512,
      readers: injected
    })
    expect(injected.readTail).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200, beforeOffset: 512 })
    )
  })

  it('refuses an unresolvable session as transcript-not-found, not as silence', async () => {
    const result = await readAgentTranscriptForSource({
      handle: 't-1',
      source: SOURCE,
      readers: readers({ resolvePath: vi.fn().mockResolvedValue(null) })
    })
    expect(result).toMatchObject({
      available: false,
      unavailable: 'transcript-not-found',
      sessionId: 'sess-1',
      path: null,
      turns: []
    })
    expect(result.detail).toContain('retry')
  })

  it('separates a vanished file from a failed read', async () => {
    const missing = await readAgentTranscriptForSource({
      handle: 't-1',
      source: SOURCE,
      readers: readers({
        readTail: vi.fn().mockResolvedValue({ error: 'ENOENT', notFound: true })
      })
    })
    const broken = await readAgentTranscriptForSource({
      handle: 't-1',
      source: SOURCE,
      readers: readers({ readTail: vi.fn().mockResolvedValue({ error: 'EACCES' }) })
    })
    expect(missing.unavailable).toBe('transcript-not-found')
    expect(broken).toMatchObject({ unavailable: 'read-failed', path: expect.any(String) })
    expect(broken.detail).toContain('EACCES')
  })

  it('returns the decoded turns with the file it actually read', async () => {
    const result = await readAgentTranscriptForSource({
      handle: 't-1',
      source: SOURCE,
      readers: readers({
        readTail: vi.fn().mockResolvedValue({
          messages: [
            {
              id: 'm-1',
              role: 'tool',
              blocks: [{ type: 'tool-result', output: 'line 1\nline 2' }],
              timestamp: 5,
              source: 'transcript'
            }
          ],
          hasMore: true,
          beforeOffset: 4096
        })
      })
    })
    expect(result).toMatchObject({
      available: true,
      path: '/home/u/.claude/projects/p/sess-1.jsonl',
      hasMoreBefore: true,
      previousOffset: 4096
    })
    expect(result.turns[0]!.blocks[0]).toMatchObject({
      kind: 'tool-result',
      output: 'line 1\nline 2'
    })
  })
})
