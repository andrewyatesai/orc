// The census ratchet's negative test. A ceiling nobody has watched reject anything is
// not a ratchet — and this one has three ways to go quietly blind: a baseline left stale
// (REVIEW forever, so new growth reads the same as old), a watched key the census stopped
// emitting, and a non-numeric ceiling that no value can exceed. Every case here runs the
// real `gauntlet.mjs census` CLI against the real repo, plants one violation, and restores.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const GAUNTLET = path.join(import.meta.dirname, 'gauntlet.mjs')
const BASELINE = path.join(import.meta.dirname, 'census-ratchet.json')
const REPORT = path.join(import.meta.dirname, '.gauntlet-report.json')
const WATCHED = path.resolve(import.meta.dirname, '..', '..', 'src', 'main', 'ipc', 'pty.ts')

let pristineBaseline = ''
let pristineWatched = Buffer.alloc(0)
let priorReport = null

function runCensus() {
  const r = spawnSync(process.execPath, [GAUNTLET, 'census'], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' }
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const withBaseline = (mutate) => {
  const b = JSON.parse(pristineBaseline)
  mutate(b)
  writeFileSync(BASELINE, `${JSON.stringify(b, null, 2)}\n`)
}

beforeAll(() => {
  pristineBaseline = readFileSync(BASELINE, 'utf8')
  pristineWatched = readFileSync(WATCHED)
  priorReport = existsSync(REPORT) ? readFileSync(REPORT, 'utf8') : null
})

afterEach(() => {
  writeFileSync(BASELINE, pristineBaseline)
  writeFileSync(WATCHED, pristineWatched)
})

afterAll(() => {
  // The CLI runs clobber a developer's last report; put it back.
  if (priorReport === null) {
    rmSync(REPORT, { force: true })
  } else {
    writeFileSync(REPORT, priorReport)
  }
})

describe('gauntlet census ratchet', () => {
  it('passes on the committed tree — the ceilings match what the census measures', () => {
    const { code, out } = runCensus()
    expect(out).toContain('regret class did not grow')
    expect(code).toBe(0)
  })

  it('REVIEWs when a watched file actually grows past its ceiling', () => {
    writeFileSync(WATCHED, Buffer.concat([pristineWatched, Buffer.from('\n// planted growth\n')]))
    const { code, out } = runCensus()
    expect(out).toContain('regret class GREW')
    expect(out).toContain('src/main/ipc/pty.ts')
    expect(code).toBe(2)
  })

  it('REVIEWs a ceiling the census output no longer covers', () => {
    withBaseline((b) => {
      b['src/main/runtime/no-such-file.ts'] = 10
    })
    const { code, out } = runCensus()
    expect(out).toContain('missing from census output')
    expect(code).toBe(2)
  })

  it('REVIEWs a non-numeric ceiling instead of treating it as unexceedable', () => {
    withBaseline((b) => {
      b['src/main/ipc/pty.ts'] = '6204'
    })
    const { code, out } = runCensus()
    expect(out).toContain('is not a number')
    expect(code).toBe(2)
  })

  it('reads `_`-prefixed keys as rationale, not as a ceiling that can never be met', () => {
    withBaseline((b) => {
      b._note = { why: 'a re-baseline record, not a metric' }
    })
    const { code, out } = runCensus()
    expect(out).not.toContain('_note')
    expect(code).toBe(0)
  })
})
