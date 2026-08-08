import { describe, expect, it, vi } from 'vitest'
import {
  createProviderLimitOutputDetector,
  extractProviderLimit,
  type ProviderLimitObservation
} from './provider-limit-output-detector'

describe('extractProviderLimit', () => {
  it.each([
    'Claude usage limit reached. Your limit will reset at 5pm (America/New_York).',
    "You've hit your weekly limit.",
    'Error: rate limit exceeded',
    'quota exceeded for this project',
    'You are out of credits.'
  ])('recognizes %s', (line) => {
    expect(extractProviderLimit(line)).not.toBeNull()
  })

  it('parses the reset clause into a timestamp', () => {
    const observation = extractProviderLimit('Usage limit reached. Resets at 5pm (UTC).')
    expect(observation?.resetDescription).toBe('5pm (UTC')
    expect(typeof observation?.resetsAt).toBe('number')
  })

  it('reports the notice with no reset rather than inventing one', () => {
    const observation = extractProviderLimit('Usage limit reached.')
    expect(observation).toMatchObject({ resetsAt: null, resetDescription: null })
  })

  it('strips terminal control sequences before matching', () => {
    expect(extractProviderLimit('[31mUsage limit reached[0m')).not.toBeNull()
  })

  it.each([
    ['a queued prompt', '> what happens when usage limit reached?'],
    ['a quoted explanation', '// usage limit reached means you wait'],
    ['a grep hit', '42: usage limit reached'],
    ['unrelated output', 'npm warn deprecated'],
    ['an empty line', '   ']
  ])('does not fire on %s — a false limit would rotate a healthy account', (_label, line) => {
    expect(extractProviderLimit(line)).toBeNull()
  })
})

describe('createProviderLimitOutputDetector', () => {
  function collect(repeatSuppressionMs?: number) {
    const seen: ProviderLimitObservation[] = []
    let clock = 0
    const detector = createProviderLimitOutputDetector({
      onLimit: (observation) => seen.push(observation),
      repeatSuppressionMs,
      now: () => clock
    })
    return { seen, detector, advance: (ms: number) => (clock += ms) }
  }

  it('emits once for a banner that arrives split across chunks', () => {
    const { seen, detector } = collect()
    detector.observe('Claude usage ')
    detector.observe('limit reached.\n')
    expect(seen).toHaveLength(1)
  })

  it('fires on a bare \\r repaint that never emits a newline', () => {
    const { seen, detector } = collect()
    detector.observe('Usage limit reached.\r')
    expect(seen).toHaveLength(1)
  })

  it('suppresses a repainting TUI redrawing the same banner', () => {
    const { seen, detector, advance } = collect(60_000)
    for (let i = 0; i < 20; i++) {
      advance(50)
      detector.observe('Usage limit reached.\r')
    }
    expect(seen).toHaveLength(1)
  })

  it('re-emits once the suppression window lapses — a second episode is real', () => {
    const { seen, detector, advance } = collect(60_000)
    detector.observe('Usage limit reached.\n')
    advance(60_001)
    detector.observe('Usage limit reached.\n')
    expect(seen).toHaveLength(2)
  })

  it('emits a different notice immediately', () => {
    const { seen, detector } = collect(60_000)
    detector.observe('Usage limit reached.\n')
    detector.observe('quota exceeded\n')
    expect(seen).toHaveLength(2)
  })

  it('reset() re-arms the same notice', () => {
    const { seen, detector } = collect(60_000)
    detector.observe('Usage limit reached.\n')
    detector.reset()
    detector.observe('Usage limit reached.\n')
    expect(seen).toHaveLength(2)
  })

  it('stays silent on ordinary agent output', () => {
    const onLimit = vi.fn()
    const detector = createProviderLimitOutputDetector({ onLimit })
    detector.observe('Reading files...\nEditing src/index.ts\n✓ done\n')
    expect(onLimit).not.toHaveBeenCalled()
  })
})

describe('does not fire on code or diffs about limits', () => {
  it.each([
    ['a diff addition', '+  /\\busage limit reached\\b/i,'],
    ['a diff removal', "-    'Claude usage limit reached. Your limit will reset at 5pm.',"],
    ['a diff hunk header', '@@ -40,7 +40,7 @@ const LIMIT_MARKERS'],
    ['a grep hit with a path', 'src/main/detector.ts:44:  /usage limit reached/i,'],
    ['a source string literal', `const M = 'usage limit reached'`],
    ['a comment', '// fires when the provider says usage limit reached']
  ])('%s', (_label, line) => {
    // An agent reviewing THIS detector prints these. A false positive here would
    // make a future router rotate away from a healthy account.
    expect(extractProviderLimit(line)).toBeNull()
  })

  it('still fires on the provider actually saying it', () => {
    expect(extractProviderLimit('Claude usage limit reached. Resets at 5pm.')).not.toBeNull()
  })
})
