import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, type UserConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createPlainNodeEntryGuardPlugin } from './build-plugins/plain-node-entry-guard'
import { createMainOutputRelativePathGuardPlugin } from './build-plugins/main-output-relative-path-guard'
import { createPreloadBridgeGuardPlugin } from './build-plugins/preload-bridge-guard'
import { createMainCompileCacheBootstrapPlugin } from './build-plugins/main-compile-cache-bootstrap'
import { createMainBootstrapPlugin } from './build-plugins/main-startup-bootstrap'
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

export const electronViteConfig: UserConfig = {
  main: {
    build: {
      rollupOptions: {
        // Why: without this, rolldown may park a module shared by two entries
        // INSIDE one entry's chunk and have the other require it from there —
        // then tree-shake the symbol out, because the hosting entry never uses
        // it. index.js shipped a call to a function its sibling entry does not
        // export, and the packaged app died before its first window.
        preserveEntrySignatures: 'strict',
        // Why: every main runtime dependency resolves from packaged node_modules
        // (the fork has no Node daemon entry, so nothing needs bundling).
        external: isExternalMainModule,
        input: {
          index: resolve('src/main/index.ts'),
          // Why: sandboxed webview preloads cannot load Rollup helper chunks, so the
          // window.close guard ships as its own standalone CJS entry in out/main.
          'browser-window-close-preload': resolve('src/preload/browser-window-close.ts'),
          'computer-sidecar': resolve('src/main/computer/sidecar-entry.ts'),
          'stt-worker': resolve('src/main/speech/stt-worker.ts'),
          'warp-theme-parser-worker': resolve('src/main/warp-themes/warp-theme-parser-worker.ts'),
          'session-scanner-opencode-sqlite-worker-entry': resolve(
            'src/main/ai-vault/session-scanner-opencode-sqlite-worker-entry.ts'
          ),
          // Why (#11161): runs the port-scan probe spawns (lsof/ps/netstat/
          // powershell) off the main-process UI thread so an EDR hook on
          // CreateProcessW cannot freeze the window. Must stay electron-free.
          'port-scan-command-worker-entry': resolve(
            'src/main/ports/port-scan-command-worker-entry.ts'
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
          // Why: real Electron (NOT run-as-node — safeStorage does not exist there), spawned as a
          // disposable child so a keychain call that never returns is killed instead of wedging the
          // runtime's main thread. bootstrap.js dispatches here on ORCA_E2EE_SECRET_HELPER.
          'e2ee-secret-unseal-entry': resolve('src/main/runtime/e2ee-secret-unseal-entry.ts'),
          // Why these three are entries at all: electron-vite CLEANS out/main,
          // and `build:cli`'s tsc emits into the same tree. Whichever runs last
          // wins, so a plain `pnpm dev` after `pnpm build:cli` used to delete
          // the modules the CLI requires and every `orca` command died with
          // "Cannot find module '../../main/daemon/client'". Listing them here
          // makes electron-vite re-emit them on every rebuild, so the two
          // builds coexist instead of racing.
          //
          // The set is not arbitrary: it is exactly the `src/main/**` paths the
          // built CLI requires at RUNTIME. `config/scripts/check-cli-main-entry-coverage.mjs`
          // recomputes that set from source and fails if this list drifts.
          'agent-hooks/managed-agent-hook-controls': resolve(
            'src/main/agent-hooks/managed-agent-hook-controls.ts'
          ),
          'daemon/client': resolve('src/main/daemon/client.ts'),
          'daemon/daemon-spawner': resolve('src/main/daemon/daemon-spawner.ts')
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
          createMainBootstrapPlugin(),
          createPlainNodeEntryGuardPlugin(),
          createMainOutputRelativePathGuardPlugin()
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
