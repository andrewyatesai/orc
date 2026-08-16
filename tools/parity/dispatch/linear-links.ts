// TS dispatch for the linear-links parity module: maps the shared vector
// function names to the real TS reference so the harness compares it against
// the Rust port.
//
// The three URL BUILDERS were cut over — their bodies are gone from
// `src/shared/linear-links.ts`, which now keeps the origin, the two global
// settings URLs and both parsers. Like the wsl-paths, worktree-id,
// stable-pane-id and branch-name-from-work adapters, they are driven through
// the SHIM rather than the wasm oracle, so the harness keeps a real TS-vs-Rust
// differential instead of degenerating to wasm-vs-binary:
// config/vitest.parity.config.ts installs no setup file, so the seam is unbound
// here and the shim answers from its `parity` fallback — which is exactly the
// deleted body, and exactly the code main/renderer/relay run before (or
// without) a binding.
import {
  buildLinearPersonalApiKeySettingsUrl,
  buildLinearTeamUrl,
  buildLinearWorkspaceApiSettingsUrl
} from '../../../src/shared/linear-app-urls'
// getLinearOrganizationUrlKeyFromIssueUrl is deliberately NOT cut over (the core
// hand-rolls `new URL`; see its header), so this stays the live TS reference and
// the vectors keep a genuine differential over it.
import { getLinearOrganizationUrlKeyFromIssueUrl } from '../../../src/shared/linear-links'
// parseLinearIssueInput IS cut over to the Rust core (napi in main + cli), so it
// drives that binding directly — the vectors' TS-derived goldens pin it, and the
// TS-vs-Rust diff degenerates to napi-vs-binary.
import { requireRustGitBinding } from '../../../src/main/daemon/rust-git-addon'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'buildLinearTeamUrl': {
      const { organizationUrlKey, teamKey } = input as {
        organizationUrlKey?: string | null
        teamKey?: string | null
      }
      return buildLinearTeamUrl({ organizationUrlKey, teamKey })
    }
    case 'buildLinearPersonalApiKeySettingsUrl':
      return buildLinearPersonalApiKeySettingsUrl(input as string | null | undefined)
    case 'buildLinearWorkspaceApiSettingsUrl':
      return buildLinearWorkspaceApiSettingsUrl(input as string | null | undefined)
    case 'getLinearOrganizationUrlKeyFromIssueUrl':
      return getLinearOrganizationUrlKeyFromIssueUrl(input as string | null | undefined)
    case 'parseLinearIssueInput':
      return JSON.parse(
        requireRustGitBinding().orcaDispatch(
          'linear-links',
          'parseLinearIssueInput',
          JSON.stringify(input ?? null)
        )
      )
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
