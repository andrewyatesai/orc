/**
 * The Classic non-regression guarantee, made mechanical
 * (`docs/reference/app-modes.md` §6).
 *
 * If these fail, "Classic is today's product, unchanged to the byte" is false —
 * and the failure would be invisible in Classic itself, which is exactly why it
 * needs a test rather than a code review.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAppModeSidecarPath } from './app-mode-sidecar-file'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').replace('encrypted:', '')
  }
}))

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

async function freshStore(dataFile: string) {
  vi.resetModules()
  const { Store } = await import('../persistence')
  return new Store({ dataFile })
}

describe('app-mode persistence boundary', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-app-mode-boundary-'))
    delete process.env.ORCA_APP_MODE
  })

  afterEach(() => {
    delete process.env.ORCA_APP_MODE
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('a mode switch leaves orca-data.json byte-identical', async () => {
    const dataFile = join(testState.dir, 'orca-data.json')
    const store = await freshStore(dataFile)
    store.flush()
    const before = readFileSync(dataFile, 'utf-8')

    store.setAppMode('alab')
    store.flush()

    expect(readFileSync(dataFile, 'utf-8')).toBe(before)
    // And specifically: the key never enters the persisted settings object.
    expect(
      Object.hasOwn(
        (JSON.parse(before) as { settings: Record<string, unknown> }).settings,
        'appMode'
      )
    ).toBe(false)
  })

  it('appMode cannot enter state.settings through updateSettings either', async () => {
    const dataFile = join(testState.dir, 'orca-data.json')
    const store = await freshStore(dataFile)
    store.flush()
    const before = readFileSync(dataFile, 'utf-8')

    // The write path a renderer, the CLI or an agent would actually use.
    store.updateSettings({ appMode: 'story-world' })
    store.flush()

    const after = JSON.parse(readFileSync(dataFile, 'utf-8')) as {
      settings: Record<string, unknown>
    }
    expect(Object.hasOwn(after.settings, 'appMode')).toBe(false)
    expect(readFileSync(dataFile, 'utf-8')).toBe(before)
    // ...but it IS observable through the projection.
    expect(store.getSettings().appMode).toBe('story-world')
  })

  it('never creates the sidecar for a user who stays in Classic', async () => {
    const dataFile = join(testState.dir, 'orca-data.json')
    const store = await freshStore(dataFile)
    store.flush()

    // A no-op set must not bring the file into existence — otherwise every
    // Classic profile grows an app-mode.json it never asked for.
    store.setAppMode('classic')
    store.updateSettings({ appMode: 'classic' })

    expect(existsSync(getAppModeSidecarPath(dataFile))).toBe(false)
  })

  it('writes the sidecar once a real mode is chosen, and reads it back on next launch', async () => {
    const dataFile = join(testState.dir, 'orca-data.json')
    const store = await freshStore(dataFile)
    store.setAppMode('alab')
    expect(existsSync(getAppModeSidecarPath(dataFile))).toBe(true)

    const relaunched = await freshStore(dataFile)
    expect(relaunched.getSettings().appMode).toBe('alab')
  })

  it('getSettings() stays reference-stable, or ~177 identity comparisons break', async () => {
    const store = await freshStore(join(testState.dir, 'orca-data.json'))
    expect(store.getSettings()).toBe(store.getSettings())
  })

  it('the projection invalidates on a settings write, so the return value is current', async () => {
    const store = await freshStore(join(testState.dir, 'orca-data.json'))
    const returned = store.updateSettings({ appIcon: 'classic' })
    // The renderer replaces its whole settings object with this return value; if
    // it were raw state.settings the mode would be wiped on every write.
    expect(returned).toBe(store.getSettings())
    expect(returned.appMode).toBe('classic')
  })

  it('a settings write does not lose a previously chosen mode', async () => {
    const store = await freshStore(join(testState.dir, 'orca-data.json'))
    store.setAppMode('alab')
    const returned = store.updateSettings({ appIcon: 'classic' })
    expect(returned.appMode).toBe('alab')
  })

  it('an unrecognized mode in the file boots Classic and does NOT overwrite the file', async () => {
    const dataFile = join(testState.dir, 'orca-data.json')
    const sidecar = getAppModeSidecarPath(dataFile)
    const handEdited = '{\n  "appMode": "kids",\n  "lock": false\n}\n'
    writeFileSync(sidecar, handEdited, 'utf-8')

    const store = await freshStore(dataFile)

    expect(store.getSettings().appMode).toBe('classic')
    expect(store.getUnrecognizedAppMode()).toBe('kids')
    // A user who mistyped one character does not lose their file.
    expect(readFileSync(sidecar, 'utf-8')).toBe(handEdited)
  })

  it('the env var outranks the sidecar and is never persisted', async () => {
    const dataFile = join(testState.dir, 'orca-data.json')
    const store = await freshStore(dataFile)
    store.setAppMode('alab')

    process.env.ORCA_APP_MODE = 'story-world'
    const relaunched = await freshStore(dataFile)

    expect(relaunched.getSettings().appMode).toBe('story-world')
    expect(relaunched.getAppModeResolution().source).toBe('env')
    // The file still says what the user chose; the env var only shadows it.
    expect(JSON.parse(readFileSync(getAppModeSidecarPath(dataFile), 'utf-8'))).toMatchObject({
      appMode: 'alab'
    })
  })

  it('a locked sidecar reports a source the selectors render read-only', async () => {
    const dataFile = join(testState.dir, 'orca-data.json')
    const store = await freshStore(dataFile)
    store.setAppMode('story-world', { lock: true })

    const relaunched = await freshStore(dataFile)
    expect(relaunched.getAppModeResolution()).toEqual({ mode: 'story-world', source: 'lock' })
  })
})
