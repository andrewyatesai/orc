import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult,
  RuntimeMobileMarkdownRequest,
  RuntimeMobileMarkdownResponse
} from '../../shared/mobile-markdown-document'

const MOBILE_MARKDOWN_RENDERER_TIMEOUT_MS = 20_000
const RESPONSE_CHANNEL = 'ui:mobileMarkdownResponse'

type RendererMobileMarkdownRequest = RuntimeMobileMarkdownRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, 'id'>
    : never
  : never

type MobileMarkdownResult = RuntimeMarkdownReadTabResult | RuntimeMarkdownSaveTabResult

type PendingMobileMarkdownRequest = {
  // Why: kept per-request so the shared dispatcher can still validate that a
  // response came from the exact window that issued this request id.
  webContents: Electron.WebContents
  resolve: (result: MobileMarkdownResult) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// Why: a mobile-relay client can hold many concurrent markdown reads/saves;
// attaching one ipcMain listener per in-flight request pinned N listeners on
// this one shared channel (MaxListenersExceededWarning at 11+, O(N) fan-out per
// response). One shared dispatcher + a request-id map keeps listener retention
// O(1) regardless of concurrency; per-request state (incl. the sender to
// validate against) lives only in the map.
const pendingRequests = new Map<string, PendingMobileMarkdownRequest>()
const windowsWithCleanup = new WeakSet<BrowserWindow>()
let responseListener:
  | ((event: Electron.IpcMainEvent, response: RuntimeMobileMarkdownResponse) => void)
  | null = null

function releaseIdleDispatcher(): void {
  if (pendingRequests.size > 0 || !responseListener) {
    return
  }
  ipcMain.removeListener(RESPONSE_CHANNEL, responseListener)
  responseListener = null
}

function ensureDispatcher(): void {
  if (responseListener) {
    return
  }
  responseListener = (
    event: Electron.IpcMainEvent,
    response: RuntimeMobileMarkdownResponse
  ): void => {
    const pending = pendingRequests.get(response.id)
    if (!pending) {
      return
    }
    // Why: request ids are visible to renderer code; only the window that issued
    // this id may settle its promise. A response from any other sender is dropped.
    if (event.sender !== pending.webContents) {
      return
    }
    clearTimeout(pending.timeout)
    pendingRequests.delete(response.id)
    releaseIdleDispatcher()
    if (response.ok) {
      pending.resolve(response.result)
    } else {
      pending.reject(new Error(response.error))
    }
  }
  ipcMain.on(RESPONSE_CHANNEL, responseListener)
}

function ensureWindowCleanup(mainWindow: BrowserWindow, webContents: Electron.WebContents): void {
  if (windowsWithCleanup.has(mainWindow)) {
    return
  }
  windowsWithCleanup.add(mainWindow)
  // Why: if the window closes before renderers reply, its pending entries would
  // otherwise linger until the 20s timeout; reject them promptly and detach the
  // shared listener once the map drains.
  mainWindow.once('closed', () => {
    for (const [id, pending] of pendingRequests) {
      if (pending.webContents !== webContents) {
        continue
      }
      clearTimeout(pending.timeout)
      pendingRequests.delete(id)
      pending.reject(new Error('renderer_unavailable'))
    }
    releaseIdleDispatcher()
  })
}

export async function requestMobileMarkdownFromRenderer(
  mainWindow: BrowserWindow,
  request: RendererMobileMarkdownRequest
): Promise<MobileMarkdownResult> {
  if (mainWindow.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const webContents = mainWindow.webContents
  const id = randomUUID()
  return await new Promise<MobileMarkdownResult>((resolve, reject) => {
    ensureDispatcher()
    ensureWindowCleanup(mainWindow, webContents)
    const timeout = setTimeout(() => {
      pendingRequests.delete(id)
      releaseIdleDispatcher()
      reject(new Error('renderer_timeout'))
    }, MOBILE_MARKDOWN_RENDERER_TIMEOUT_MS)
    pendingRequests.set(id, { webContents, resolve, reject, timeout })
    webContents.send('ui:mobileMarkdownRequest', { id, ...request })
  })
}
