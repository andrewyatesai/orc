// Electron wiring for the orca://app renderer scheme (moonshot Wave 2):
// registerRendererScheme() must run BEFORE app-ready (Chromium locks the
// privileged-scheme table at ready); installRendererSchemeHandler() after
// ready, before any window load. file:// documents get zero V8 code cache;
// this scheme's codeCache:true is the whole point of the migration.
import { join } from 'node:path'
import { protocol, type Session } from 'electron'
import {
  createRendererSchemeRequestHandler,
  crossOriginIsolationEnabled,
  RENDERER_SCHEME
} from './renderer-scheme-request-handler'

export {
  isRendererSchemeSenderUrl,
  rendererPageUrl,
  RENDERER_ORIGIN,
  RENDERER_SCHEME
} from './renderer-scheme-request-handler'
import { outMainDirectory } from '../out-main-directory'

export function registerRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true
      }
    }
  ])
}

// Live map shared by every installed handler, so a mount registered after
// install (e.g. from an IPC handler setup) still serves. Same-origin as the
// renderer, so the injected CSP's 'self' covers mounted assets.
const rendererSchemeMounts = new Map<string, string>()

// First-segment names the out/renderer bundle owns: a mount with one of these
// would shadow the app bundle for every request under it.
const RESERVED_MOUNT_PREFIXES = new Set(['assets'])

/** Serve directoryPath at orca://app/<prefix>/…; prefix is a single path segment. */
export function registerRendererSchemeMount(prefix: string, directoryPath: string): void {
  if (prefix === '' || prefix.includes('/') || prefix.includes('\\')) {
    throw new Error(`Invalid renderer scheme mount prefix: ${prefix}`)
  }
  // '.' also rejects every top-level bundle FILE name (index.html, popout.html…).
  if (RESERVED_MOUNT_PREFIXES.has(prefix) || prefix.includes('.')) {
    throw new Error(`Renderer scheme mount prefix shadows the app bundle: ${prefix}`)
  }
  const existing = rendererSchemeMounts.get(prefix)
  if (existing !== undefined && existing !== directoryPath) {
    throw new Error(`Renderer scheme mount prefix already registered: ${prefix}`)
  }
  rendererSchemeMounts.set(prefix, directoryPath)
}

// protocol.handle throws on double registration; sessions outlive HMR-free
// prod but the popout partition re-requests install on every open.
const installedProtocols = new WeakSet<object>()

/**
 * Serve out/renderer on orca://app for one session. Default session when no
 * argument; isolated-partition windows (dashboard popout) pass their own —
 * protocol handlers are per-session, unlike the global scheme privileges.
 */
export function installRendererSchemeHandler(targetSession?: Session): void {
  const sessionProtocol = targetSession ? targetSession.protocol : protocol
  if (installedProtocols.has(sessionProtocol)) {
    return
  }
  installedProtocols.add(sessionProtocol)
  sessionProtocol.handle(
    RENDERER_SCHEME,
    createRendererSchemeRequestHandler({
      rootDir: join(outMainDirectory(), '../renderer'),
      mounts: rendererSchemeMounts,
      // Opt-in read per install, not per request: responses flipping isolation
      // mid-session would leave documents and their workers split across
      // incompatible embedder policies.
      crossOriginIsolation: crossOriginIsolationEnabled(process.env)
    })
  )
}
