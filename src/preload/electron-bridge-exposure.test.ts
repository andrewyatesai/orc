// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Why: pins the preload contextBridge surface so window.electron can never regress back to the
// @electron-toolkit generic ipcRenderer passthrough or a full process.env copy (security audit).

type ExposeCall = { key: string; value: unknown }
const exposed: ExposeCall[] = []

vi.mock('electron', () => {
  const ipcRenderer = {
    on: vi.fn(() => () => {}),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn(),
    invoke: vi.fn(async () => undefined),
    postMessage: vi.fn()
  }
  return {
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, value: unknown) => {
        exposed.push({ key, value })
      })
    },
    ipcRenderer,
    webFrame: { setZoomFactor: vi.fn(), setZoomLevel: vi.fn(), insertCSS: vi.fn() },
    webUtils: { getPathForFile: vi.fn(() => '') }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function loadPreload(): Promise<ExposeCall[]> {
  exposed.length = 0
  // contextIsolated true drives the contextBridge.exposeInMainWorld path.
  Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
  await vi.resetModules()
  await import('./index')
  return exposed
}

describe('preload window.electron exposure', () => {
  it('exposes a window.electron object that is not a generic IPC passthrough', async () => {
    const calls = await loadPreload()
    const electron = calls.find((c) => c.key === 'electron')?.value as
      | Record<string, unknown>
      | undefined

    expect(electron).toBeTruthy()
    // No generic channel passthrough may leak through window.electron.
    expect((electron as { ipcRenderer?: unknown }).ipcRenderer).toBeUndefined()
    // No invoke/send/on channel-taking methods anywhere on the exposed object.
    expect(typeof (electron as { invoke?: unknown }).invoke).not.toBe('function')
    expect(typeof (electron as { send?: unknown }).send).not.toBe('function')
    expect(typeof (electron as { on?: unknown }).on).not.toBe('function')
  })

  it('does not leak the main-process environment or webUtils to the renderer', async () => {
    const calls = await loadPreload()
    const electron = calls.find((c) => c.key === 'electron')?.value as
      | Record<string, unknown>
      | undefined

    expect(electron).toBeTruthy()
    // process.env copy must never reach the renderer.
    expect((electron as { process?: { env?: unknown } }).process?.env).toBeUndefined()
    // File->host-path resolver must not be exposed.
    expect((electron as { webUtils?: unknown }).webUtils).toBeUndefined()
  })

  it('keeps a type-only electron ambient anchor in api-types (no runtime toolkit re-import)', () => {
    // Why: api-types.ts is the sole web-tsconfig include that pulls the `electron` package's
    // ambient `Electron` namespace (Electron.FoundInPageEvent, WebviewTag, …) into the browser-pane
    // graph. Dropping the toolkit ElectronAPI import removed that anchor and broke `pnpm typecheck`
    // with 29 TS2503 failures; this pins the type-only replacement so it can't silently regress.
    // vitest runs with cwd at repo root; import.meta.url is not a file:// URL under happy-dom.
    const source = readFileSync(join(process.cwd(), 'src/preload/api-types.ts'), 'utf8')
    const hasEmptyTypeImport = /import\s+type\s*\{\s*\}\s*from\s*['"]electron['"]/.test(source)
    const hasReferenceDirective = /\/\/\/\s*<reference\s+types=["']electron["']\s*\/>/.test(source)
    expect(hasEmptyTypeImport || hasReferenceDirective).toBe(true)
    // The anchor must stay type-only: no runtime value import of the toolkit passthrough.
    expect(source).not.toMatch(/^\s*import\s+(?!type\b)[^\n]*@electron-toolkit\/preload/m)
  })

  it('exposes only a frozen platform/versions snapshot on window.electron', async () => {
    const calls = await loadPreload()
    const electron = calls.find((c) => c.key === 'electron')?.value as
      | { platform?: unknown; versions?: unknown }
      | undefined

    expect(electron).toBeTruthy()
    expect(typeof electron?.platform).toBe('string')
    expect(typeof electron?.versions).toBe('object')
    expect(Object.isFrozen(electron)).toBe(true)
  })
})
