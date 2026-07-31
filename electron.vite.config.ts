import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, type UserConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createPlainNodeEntryGuardPlugin } from './build-plugins/plain-node-entry-guard'
import { createPreloadBridgeGuardPlugin } from './build-plugins/preload-bridge-guard'
import { createMainCompileCacheBootstrapPlugin } from './build-plugins/main-compile-cache-bootstrap'
import { createChunkModuleDumpPlugin } from './build-plugins/renderer-chunk-module-dump'
import {
  createRendererChunkBudgetPlugin,
  createRendererWorkerChunkBudgetPlugin
} from './build-plugins/renderer-chunk-budget'
import { createRendererContentSecurityPolicyPlugin } from './build-plugins/renderer-content-security-policy'
import { createWorkerUrlGuardPlugin } from './build-plugins/worker-url-guard'
import { computeOrcaBuildInfoLiteral } from './build-plugins/orca-build-info'
import packageJson from './package.json' with { type: 'json' }

const EXTERNAL_MAIN_DEPENDENCIES = Object.keys(packageJson.dependencies)

function isExternalMainModule(source: string): boolean {
  if (isBuiltin(source) || source === 'electron' || source.startsWith('electron/')) {
    return true
  }
  return EXTERNAL_MAIN_DEPENDENCIES.some(
    (dependency) => source === dependency || source.startsWith(`${dependency}/`)
  )
}

const ORCA_BUILD_INFO_LITERAL = computeOrcaBuildInfoLiteral()

// Why: the telemetry transport is gated by two compile-time constants that
// only the official CI release workflow sets. Contributor / `pnpm dev` /
// third-party rebuilds must substitute literal `null` at these sites so
// `IS_OFFICIAL_BUILD` in `src/main/telemetry/client.ts` evaluates `false`
// at module load and the track() wrapper short-circuits to console-mirror.
// The substitution happens at compile time — there is no runtime env-var
// fallback — so a curious contributor cannot spoof transmission with a
// shell export.
//
// CI injects real values via GitHub Actions secrets
// (ORCA_BUILD_IDENTITY='stable' | 'rc', ORCA_POSTHOG_WRITE_KEY=phc_...);
// every other build path resolves these env vars to undefined, which the
// JSON.stringify below folds to the literal `null`. Ambient declarations
// for the two constants live in `src/types/build-constants.d.ts`.
const orcaBuildIdentity = process.env.ORCA_BUILD_IDENTITY
const ORCA_BUILD_IDENTITY_LITERAL =
  orcaBuildIdentity === 'stable' || orcaBuildIdentity === 'rc'
    ? JSON.stringify(orcaBuildIdentity)
    : 'null'
const orcaPostHogWriteKey = process.env.ORCA_POSTHOG_WRITE_KEY
const ORCA_POSTHOG_WRITE_KEY_LITERAL =
  typeof orcaPostHogWriteKey === 'string' && orcaPostHogWriteKey.length > 0
    ? JSON.stringify(orcaPostHogWriteKey)
    : 'null'
const orcaDiagnosticsTokenUrl = process.env.ORCA_DIAGNOSTICS_TOKEN_URL
const ORCA_DIAGNOSTICS_TOKEN_URL_LITERAL =
  typeof orcaDiagnosticsTokenUrl === 'string' && orcaDiagnosticsTokenUrl.length > 0
    ? JSON.stringify(orcaDiagnosticsTokenUrl)
    : 'null'
// Fork-owned feedback endpoint (staging audit G0-2): null in unkeyed builds so
// the feedback IPC returns 'endpoint-not-configured' instead of POSTing to the
// public vendor. Same fold-to-null contract as the constants above.
const orcaFeedbackEndpoint = process.env.ORCA_FEEDBACK_ENDPOINT
const ORCA_FEEDBACK_ENDPOINT_LITERAL =
  typeof orcaFeedbackEndpoint === 'string' && orcaFeedbackEndpoint.length > 0
    ? JSON.stringify(orcaFeedbackEndpoint)
    : 'null'

function createStartupDiagnosticsBanner(chunkName: string): string {
  return `
;(() => {
  const env = typeof process !== 'undefined' ? process.env : undefined
  const mode = env?.ORCA_STARTUP_DIAGNOSTICS
  if (mode !== '1' && mode !== 'trace') {
    return
  }
  const safeJson = (value) => {
    try {
      return JSON.stringify(value)
    } catch {
      return '"<unserializable>"'
    }
  }
  let closeSync
  let diagnosticFileDescriptor
  let openSync
  let writeSync
  try {
    const fs = require('node:fs')
    closeSync = fs.closeSync
    openSync = fs.openSync
    writeSync = fs.writeSync
  } catch {
    closeSync = undefined
    openSync = undefined
    writeSync = undefined
  }
  const diagnosticFile = env?.ORCA_STARTUP_DIAGNOSTICS_FILE
  if (typeof diagnosticFile === 'string' && diagnosticFile.length > 0 && typeof openSync === 'function') {
    try {
      diagnosticFileDescriptor = openSync(diagnosticFile, 'a', 0o600)
    } catch {
      diagnosticFileDescriptor = undefined
    }
  }
  const writeLine = (message) => {
    try {
      const line = message.endsWith('\\n') ? message : message + '\\n'
      if (typeof writeSync === 'function') {
        writeSync(2, line)
        if (typeof diagnosticFileDescriptor === 'number') {
          writeSync(diagnosticFileDescriptor, line)
        }
      }
    } catch {
      // Diagnostics must never affect startup.
    }
  }
  const chunkName = ${JSON.stringify(chunkName)}
  writeLine('[bootstrap] bundle-enter chunk=' + safeJson(chunkName) + ' pid=' + process.pid + ' ppid=' + process.ppid + ' execPath=' + safeJson(process.execPath) + ' argv=' + safeJson(process.argv) + ' electronRunAsNode=' + safeJson(env?.ELECTRON_RUN_AS_NODE ?? null))
  if (!globalThis.__ORCA_BOOTSTRAP_EXIT_LOG_INSTALLED__) {
    globalThis.__ORCA_BOOTSTRAP_EXIT_LOG_INSTALLED__ = true
    process.once('exit', (code) => {
      writeLine('[bootstrap] process-exit code=' + code)
      if (typeof closeSync === 'function' && typeof diagnosticFileDescriptor === 'number') {
        try {
          closeSync(diagnosticFileDescriptor)
        } catch {
          // Diagnostics must never affect shutdown.
        }
      }
    })
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      const message = error && typeof error === 'object' && 'stack' in error ? error.stack : error
      writeLine('[bootstrap] uncaught-exception origin=' + safeJson(origin) + ' error=' + safeJson(String(message)))
    })
    process.on('unhandledRejection', (reason) => {
      const message = reason && typeof reason === 'object' && 'stack' in reason ? reason.stack : reason
      writeLine('[bootstrap] unhandled-rejection error=' + safeJson(String(message)))
    })
  }
  if (mode === 'trace' && !globalThis.__ORCA_BOOTSTRAP_REQUIRE_TRACE_INSTALLED__) {
    globalThis.__ORCA_BOOTSTRAP_REQUIRE_TRACE_INSTALLED__ = true
    try {
      const Module = require('node:module')
      const originalLoad = Module._load
      const parsedTraceLimit = Number(env?.ORCA_STARTUP_DIAGNOSTICS_TRACE_LIMIT ?? 20000)
      const traceLimit = Number.isFinite(parsedTraceLimit) && parsedTraceLimit > 0 ? parsedTraceLimit : 20000
      let traceLineCount = 0
      let traceLimitReported = false
      const writeTraceLine = (message) => {
        if (traceLineCount >= traceLimit) {
          if (!traceLimitReported) {
            traceLimitReported = true
            writeLine('[bootstrap] require-trace-limit-reached limit=' + safeJson(traceLimit))
          }
          return
        }
        traceLineCount += 1
        writeLine(message)
      }
      Module._load = function (request, parent, isMain) {
        const parentName = parent && parent.filename ? parent.filename : null
        writeTraceLine('[bootstrap] require-start request=' + safeJson(request) + ' parent=' + safeJson(parentName) + ' isMain=' + safeJson(Boolean(isMain)))
        try {
          const result = Reflect.apply(originalLoad, this, arguments)
          writeTraceLine('[bootstrap] require-ok request=' + safeJson(request))
          return result
        } catch (error) {
          const message = error && typeof error === 'object' && 'stack' in error ? error.stack : error
          writeTraceLine('[bootstrap] require-error request=' + safeJson(request) + ' error=' + safeJson(String(message)))
          throw error
        }
      }
    } catch (error) {
      writeLine('[bootstrap] require-trace-install-error error=' + safeJson(String(error)))
    }
  }
})();
`
}

function createStartupDiagnosticsBootstrapPlugin() {
  return {
    name: 'orca-startup-diagnostics-bootstrap',
    generateBundle(_options, bundle) {
      const mainChunk = bundle['index.js']
      if (!mainChunk || mainChunk.type !== 'chunk') {
        return
      }

      // Why: source-level startup diagnostics run after Rollup's generated
      // prelude and require() list. Mutate the final emitted chunk so macOS
      // launch failures can identify the earliest JS boundary reached.
      mainChunk.code = createStartupDiagnosticsBanner(mainChunk.fileName) + mainChunk.code
    }
  }
}

export const electronViteConfig: UserConfig = {
  main: {
    build: {
      rollupOptions: {
        // Why: every main runtime dependency resolves from packaged node_modules
        // (the fork has no Node daemon entry, so nothing needs bundling).
        external: isExternalMainModule,
        input: {
          index: resolve('src/main/index.ts'),
          'computer-sidecar': resolve('src/main/computer/sidecar-entry.ts'),
          'stt-worker': resolve('src/main/speech/stt-worker.ts'),
          'warp-theme-parser-worker': resolve('src/main/warp-themes/warp-theme-parser-worker.ts'),
          'session-scanner-opencode-sqlite-worker-entry': resolve(
            'src/main/ai-vault/session-scanner-opencode-sqlite-worker-entry.ts'
          ),
          // Why: forked with ELECTRON_RUN_AS_NODE so @parcel/watcher faults
          // can't take down the main process (issue #7547).
          'parcel-watcher-process-entry': resolve('src/main/ipc/parcel-watcher-process-entry.ts'),
          // Why: run under ELECTRON_RUN_AS_NODE while the caller blocks on
          // spawnSync — codex app-server trust grants need a live event loop
          // but must finish before a Codex pane launch proceeds.
          'codex/codex-app-server-grant-entry': resolve(
            'src/main/codex/codex-app-server-grant-entry.ts'
          ),
          // Why: electron-vite cleans out/main in dev. The dev CLI imports
          // this path for `orca agent hooks ...`, so it must survive rebuilds.
          'agent-hooks/managed-agent-hook-controls': resolve(
            'src/main/agent-hooks/managed-agent-hook-controls.ts'
          )
        },
        // Why: Rolldown's SSR default is ESM, but Electron and sidecar launchers
        // consume these stable CommonJS paths.
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js'
        },
        plugins: [
          createMainCompileCacheBootstrapPlugin(),
          createStartupDiagnosticsBootstrapPlugin(),
          createPlainNodeEntryGuardPlugin()
        ]
      }
    },
    // Why: compile-time substitution for the telemetry gate. See the block
    // above for the full rationale.
    define: {
      // Why: pinned at COMPILE time so no shell export can retarget the trust anchor;
      // absent resolves to `null`, which leaves the signature tier inactive.
      ORCA_UPDATE_PUBKEY: JSON.stringify(process.env.ORCA_UPDATE_PUBKEY ?? null),
      ORCA_BUILD_IDENTITY: ORCA_BUILD_IDENTITY_LITERAL,
      ORCA_POSTHOG_WRITE_KEY: ORCA_POSTHOG_WRITE_KEY_LITERAL,
      ORCA_DIAGNOSTICS_TOKEN_URL: ORCA_DIAGNOSTICS_TOKEN_URL_LITERAL,
      ORCA_FEEDBACK_ENDPOINT: ORCA_FEEDBACK_ENDPOINT_LITERAL
    }
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: ['@electron-toolkit/preload']
      },
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          // Coordinator v0: the single-channel-pair daemon byte tunnel — kept
          // separate so that window never loads the legacy IPC surface.
          coordinator: resolve('src/preload/coordinator.ts')
        },
        // Why: `electron` in a preload is the runtime builtin, never the npm
        // package. Rolldown otherwise bundles node_modules/electron (the binary
        // path helper) and splits it into a shared chunk, which a SANDBOXED
        // preload cannot require — the bridge then fails to load and
        // window.api is silently undefined.
        external: (source: string) => source === 'electron' || source.startsWith('electron/'),
        // Why: same CJS pinning as the main build. Rolldown defaults preload to
        // ESM `.mjs`, but createMainWindow/coordinator-window pass literal
        // `../preload/index.js` and `../preload/coordinator.js`, so a renamed
        // artifact makes Electron load no preload at all.
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js'
        },
        plugins: [createPreloadBridgeGuardPlugin()]
      }
    }
  },
  renderer: {
    // Bake build provenance into the renderer too (the About panel reads it).
    define: {
      ORCA_BUILD_INFO: ORCA_BUILD_INFO_LITERAL
    },
    // electron-vite defaults renderer minify to false; the 7 MB eager entry is
    // read + V8-parsed before first paint on every cold start. esbuild-minify
    // ~halves it (measured 52%). Safe: no constructor.name/function.name
    // reflection in the renderer — every `.name` compare is on a data field.
    build: {
      minify: 'esbuild',
      // Vite's built-in warning treats every large lazy feature bundle as a
      // startup problem. The plugin below fails at 2.25 MiB per eager file,
      // 4.25 MiB per entry's full static closure, and 4.75 MiB per lazy file.
      chunkSizeWarningLimit: 5_000,
      rollupOptions: {
        // Why: a shared chunk must never import an HTML entry whose module mounts
        // a different React root (index/coordinator/popout are separate roots).
        preserveEntrySignatures: 'strict',
        input: {
          index: resolve('src/renderer/index.html'),
          // Coordinator v0's own entry (docs/rust-migration/coordinator-v0-design.md):
          // a second page, zero coupling to the main renderer's store/IPC wiring.
          coordinator: resolve('src/renderer/coordinator.html'),
          // Why: the pop-out dashboard is a second top-level window with its own
          // React root, booting independently of the main window while reusing the
          // same preload/window.api.
          popout: resolve('src/renderer/popout.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [
      react(),
      tailwindcss(),
      createChunkModuleDumpPlugin(),
      createRendererChunkBudgetPlugin('desktop'),
      // Why: inject a strict enforcing CSP into the packaged renderer HTML (build-only, so
      // dev HMR keeps its relaxed policy). See build-plugins/renderer-content-security-policy.ts.
      createRendererContentSecurityPolicyPlugin(),
      createWorkerUrlGuardPlugin()
    ],
    worker: {
      format: 'es',
      // Worker builds are separate Rollup children and do not inherit renderer
      // plugins. Monaco's 6.69 MiB TS worker has a 7.25 MiB file/closure ratchet.
      plugins: () => [createRendererWorkerChunkBudgetPlugin()]
    }
  }
}

export default defineConfig(electronViteConfig)
