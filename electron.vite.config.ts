import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { defineConfig, type UserConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createBootstrapFatalExitBanner } from './build-plugins/bootstrap-fatal-exit-banner'
import { createPlainNodeEntryGuardPlugin } from './build-plugins/plain-node-entry-guard'
import { createStartupDiagnosticsBanner } from './build-plugins/startup-diagnostics-banner'
import {
  createRendererChunkBudgetPlugin,
  createRendererWorkerChunkBudgetPlugin
} from './build-plugins/renderer-chunk-budget'
import { createRendererContentSecurityPolicyPlugin } from './build-plugins/renderer-content-security-policy'
import packageJson from './package.json' with { type: 'json' }

const BUNDLED_MAIN_DEPENDENCIES = new Set([
  // Why: Windows NSIS deploys app.asar before external resources; bootstrap must
  // not race the later resources/node_modules copy.
  'zod'
])
const EXTERNAL_MAIN_DEPENDENCIES = Object.keys(packageJson.dependencies).filter(
  (dependency) => !BUNDLED_MAIN_DEPENDENCIES.has(dependency)
)

function isExternalMainModule(source: string): boolean {
  if (isBuiltin(source) || source === 'electron' || source.startsWith('electron/')) {
    return true
  }
  return EXTERNAL_MAIN_DEPENDENCIES.some(
    (dependency) => source === dependency || source.startsWith(`${dependency}/`)
  )
}

// Build provenance for the About section, baked in at build time (a packaged app
// has no git repo / rust/aterm tree to read at runtime). Best-effort: any piece
// that can't be resolved (no git, missing file) degrades to 'unknown' rather than
// failing the build. See `ORCA_BUILD_INFO` in src/types/build-constants.d.ts.
function git(args: string): string {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}
function computeOrcaBuildInfoLiteral(): string {
  const orcaVersion = packageJson.version ?? 'unknown'
  // aterm is a pinned git submodule; its checked-out commit IS the engine version.
  const atermRevFull = git('-C rust/aterm rev-parse HEAD')
  const atermRev = atermRevFull ? atermRevFull.slice(0, 12) : 'unknown'
  // The last upstream re-sync: most recent commit whose subject starts with
  // "Merge upstream" (the convention these merges use); pull the version + hash out.
  const mergeLine = git('log -1 --grep="Merge upstream" --format="%h %s"')
  let upstreamAligned = 'unknown'
  if (mergeLine) {
    const sep = mergeLine.indexOf(' ')
    const hash = sep === -1 ? mergeLine : mergeLine.slice(0, sep)
    const subject = sep === -1 ? '' : mergeLine.slice(sep + 1)
    const version = subject.match(/v?\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? ''
    upstreamAligned = version ? `${version} (${hash})` : hash
  }
  const info = {
    orcaVersion,
    orcaCommit: git('rev-parse --short HEAD') || 'unknown',
    orcaCommitDate: git('show -s --format=%cI HEAD') || 'unknown',
    atermRev,
    upstreamFork: 'stablyai/orca',
    upstreamAligned
  }
  return JSON.stringify(info)
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

function createMainBootstrapPlugin() {
  return {
    name: 'orca-main-bootstrap',
    generateBundle(_options, bundle) {
      const mainChunk = bundle['index.js']
      if (!mainChunk || mainChunk.type !== 'chunk') {
        return
      }

      // Why: source guards and diagnostics run after Rollup's generated require
      // prelude, too late to handle a missing bootstrap dependency.
      mainChunk.code =
        createBootstrapFatalExitBanner() +
        createStartupDiagnosticsBanner(mainChunk.fileName) +
        mainChunk.code
    }
  }
}

export const electronViteConfig: UserConfig = {
  main: {
    build: {
      // Why: startup-critical pure JS must survive a partially copied Windows
      // resources tree, so it is bundled instead of externalized.
      externalizeDeps: {
        exclude: [...BUNDLED_MAIN_DEPENDENCIES]
      },
      rollupOptions: {
        // Why: native dependencies must resolve from packaged node_modules.
        external: isExternalMainModule,
        input: {
          index: resolve('src/main/index.ts'),
          // Why: sandboxed webview preloads cannot load Rollup helper chunks.
          'browser-window-close-preload': resolve('src/preload/browser-window-close.ts'),
          'plugin-host-entry': resolve('src/main/plugins/plugin-host-entry.ts'),
          'computer-sidecar': resolve('src/main/computer/sidecar-entry.ts'),
          'stt-worker': resolve('src/main/speech/stt-worker.ts'),
          'warp-theme-parser-worker': resolve('src/main/warp-themes/warp-theme-parser-worker.ts'),
          'session-scanner-opencode-sqlite-worker-entry': resolve(
            'src/main/ai-vault/session-scanner-opencode-sqlite-worker-entry.ts'
          ),
          // Why: forked with ELECTRON_RUN_AS_NODE so @parcel/watcher faults
          // can't take down the main process (issue #7547).
          'parcel-watcher-process-entry': resolve('src/main/ipc/parcel-watcher-process-entry.ts'),
          // Why: a worker thread survives the macOS 26 AppKit main-thread deadlock
          // without paying for another Electron process.
          'main-thread-hang-watchdog-entry': resolve(
            'src/main/hang-watchdog/main-thread-hang-watchdog-entry.ts'
          ),
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
          ),
          // Why: account import mutates the user's macOS Keychain from the CLI.
          'claude-accounts/keychain': resolve('src/main/claude-accounts/keychain.ts'),
          // Why: `orca status` and `orca terminal stop --all` talk to the running
          // daemon from the CLI, so these must outlive the out/main clean too.
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
        plugins: [createMainBootstrapPlugin(), createPlainNodeEntryGuardPlugin()]
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
        }
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
      // Why: config/scripts/project-renderer-web-client.mjs projects the web client
      // out of this build and resolves its assets through the manifest.
      manifest: true,
      modulePreload: { polyfill: true },
      target: 'es2020',
      // Vite's built-in warning treats every large lazy feature bundle as a
      // startup problem. The plugin below fails at 2.25 MiB per eager file,
      // 4.25 MiB per entry's full static closure, and 4.75 MiB per lazy file.
      chunkSizeWarningLimit: 5_000,
      rollupOptions: {
        // Why: shared chunks must never import an HTML entry whose module mounts
        // a different React root.
        preserveEntrySignatures: 'strict',
        input: {
          index: resolve('src/renderer/index.html'),
          // Coordinator v0's own entry (docs/rust-migration/coordinator-v0-design.md):
          // a second page, zero coupling to the main renderer's store/IPC wiring.
          coordinator: resolve('src/renderer/coordinator.html'),
          // Why: the pop-out dashboard is a second top-level window with its own
          // React root, booting independently of the main window while reusing the
          // same preload/window.api.
          popout: resolve('src/renderer/popout.html'),
          web: resolve('src/renderer/web-index.html')
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
      createRendererChunkBudgetPlugin('desktop'),
      // Why: inject a strict enforcing CSP into the packaged renderer HTML (build-only, so
      // dev HMR keeps its relaxed policy). See build-plugins/renderer-content-security-policy.ts.
      createRendererContentSecurityPolicyPlugin()
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
