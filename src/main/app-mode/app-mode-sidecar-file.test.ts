import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAppMode } from '../../shared/app-mode/resolve-app-mode'
import {
  APP_MODE_SIDECAR_FILENAME,
  getAppModeSidecarPath,
  parseAppModeSidecar,
  readAppModeSidecar,
  serializeAppModeSidecar,
  watchAppModeSidecar,
  writeAppModeSidecar
} from './app-mode-sidecar-file'

let dir: string
let dataFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-app-mode-'))
  dataFile = join(dir, 'orca-data.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const writeSidecar = (contents: string): void => {
  writeFileSync(join(dir, APP_MODE_SIDECAR_FILENAME), contents)
}

describe('app mode sidecar file', () => {
  it('lives beside the data file so it is per-profile automatically', () => {
    expect(getAppModeSidecarPath(dataFile)).toBe(join(dir, 'app-mode.json'))
  })

  it('is absent by default and resolves to built-in classic', () => {
    expect(readAppModeSidecar(dataFile)).toEqual({ pin: null, unrecognizedMode: null })
    expect(resolveAppMode({ pinned: readAppModeSidecar(dataFile).pin })).toEqual({
      mode: 'classic',
      source: 'built-in'
    })
  })

  it('reads a hand-written mode and feeds the resolver', () => {
    writeSidecar('{ "appMode": "story-world" }')
    const { pin, unrecognizedMode } = readAppModeSidecar(dataFile)
    expect(unrecognizedMode).toBeNull()
    expect(resolveAppMode({ pinned: pin })).toEqual({ mode: 'story-world', source: 'default' })
  })

  it('reports an unrecognized mode by name and still boots Classic', () => {
    writeSidecar('{ "appMode": "kids" }')
    const read = readAppModeSidecar(dataFile)
    expect(read.unrecognizedMode).toBe('kids')
    expect(resolveAppMode({ pinned: read.pin })).toEqual({ mode: 'classic', source: 'built-in' })
  })

  it.each([['ALab'], ['story world'], ['StoryWorld']])(
    'treats the near-miss spelling %j as unrecognized rather than guessing',
    (value) => {
      writeSidecar(JSON.stringify({ appMode: value }))
      expect(readAppModeSidecar(dataFile).unrecognizedMode).toBe(value)
    }
  )

  it('does not report unrecognized when the key is simply absent', () => {
    writeSidecar('{ "lock": true }')
    expect(readAppModeSidecar(dataFile).unrecognizedMode).toBeNull()
  })

  it('falls back safely on malformed JSON', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeSidecar('{ "appMode": "alab"')
    expect(readAppModeSidecar(dataFile)).toEqual({ pin: null, unrecognizedMode: null })
  })

  it.each([['[]'], ['null'], ['"alab"'], ['42']])(
    'falls back safely when the root is not an object (%s)',
    (contents) => {
      writeSidecar(contents)
      expect(readAppModeSidecar(dataFile)).toEqual({ pin: null, unrecognizedMode: null })
    }
  )

  it('carries lock through to the resolver', () => {
    writeAppModeSidecar(dataFile, 'story-world', true)
    const { pin } = readAppModeSidecar(dataFile)
    expect(resolveAppMode({ pinned: pin, repoOverride: 'alab' })).toEqual({
      mode: 'story-world',
      source: 'lock'
    })
  })

  it('writes human-readable JSON with a trailing newline and round-trips', () => {
    writeAppModeSidecar(dataFile, 'alab')
    expect(readFileSync(getAppModeSidecarPath(dataFile), 'utf8')).toBe(
      '{\n  "appMode": "alab",\n  "lock": false\n}\n'
    )
    expect(resolveAppMode({ pinned: readAppModeSidecar(dataFile).pin })).toEqual({
      mode: 'alab',
      source: 'default'
    })
  })

  it('round-trips every mode through serialize/parse', () => {
    for (const mode of ['classic', 'alab', 'story-world'] as const) {
      const { pin } = parseAppModeSidecar(serializeAppModeSidecar(mode))
      expect(resolveAppMode({ pinned: pin }).mode).toBe(mode)
    }
  })

  it('notifies once when an external edit changes the pin', async () => {
    const seen: string[] = []
    let resolveFirst: (() => void) | undefined
    const firstChange = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    writeAppModeSidecar(dataFile, 'classic')
    const stop = watchAppModeSidecar(dataFile, (read) => {
      seen.push(resolveAppMode({ pinned: read.pin }).mode)
      resolveFirst?.()
    })
    try {
      writeSidecar('{ "appMode": "alab" }')
      await Promise.race([
        firstChange,
        new Promise((_, reject) => setTimeout(() => reject(new Error('watch timed out')), 5000))
      ])
      // Why settle first: one editor save can emit several fs events, and the debounce must collapse them.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(seen).toEqual(['alab'])
    } finally {
      stop()
    }
  })

  it('stays silent when a re-save does not change the pin', async () => {
    const onPinChanged = vi.fn()
    writeAppModeSidecar(dataFile, 'alab')
    const stop = watchAppModeSidecar(dataFile, onPinChanged)
    try {
      // Same content, different formatting — a no-op save from an editor.
      writeSidecar('{"appMode":"alab","lock":false}')
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(onPinChanged).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('stops notifying after the watcher is disposed', async () => {
    const onPinChanged = vi.fn()
    writeAppModeSidecar(dataFile, 'classic')
    const stop = watchAppModeSidecar(dataFile, onPinChanged)
    stop()
    writeSidecar('{ "appMode": "story-world" }')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(onPinChanged).not.toHaveBeenCalled()
  })

  it('does not throw when the directory cannot be watched', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = watchAppModeSidecar(join(dir, 'missing', 'orca-data.json'), vi.fn())
    expect(() => stop()).not.toThrow()
  })
})
