// TS dispatch for the linear-links parity module: maps the shared vector
// function names to the real TS reference so the harness compares it against
// the Rust port.
//
// EVERY function here is answered by TypeScript. No arm reaches a wasm or napi
// artifact, so `expect(tsOutput == rustOutput)` is a real TS-vs-Rust question
// for all 5 — see `twinParseLinearIssueInput` below for the one that was not.
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
import {
  getLinearOrganizationUrlKeyFromIssueUrl,
  LINEAR_APP_HOSTNAME,
  type ParsedLinearIssueInput
} from '../../../src/shared/linear-links'

// parseLinearIssueInput's twin, restored here as the harness reference.
//
// It USED to drive `requireRustGitBinding().orcaDispatch(...)` — the napi
// oracle — which made 13 of this module's 16 parser vectors Rust-vs-Rust: both
// arms of `expect(tsOutput == rustOutput)` were Rust, so no core-vs-twin
// divergence was observable, and a wrong-workspace host widening lived through
// a green suite (measured 2026-08-16: 472 widened accepts over a 13,734-
// comparison host sweep, the whole class invisible to this file).
//
// The branch-name-from-work / workspace-statuses / wsl-paths adapters solve this
// by driving the SHIM with the seam unbound, because their shims keep a `parity`
// fallback. This one cannot: `src/shared/linear-links.ts` reaches the core
// through `requireOrcaDispatch`, which THROWS when unbound, deliberately — it
// runs only on main + CLI, which bind synchronously, and a silent fallback there
// would hide a bootstrap-order bug. Giving it one to please the harness would
// change shipped behaviour, so the twin lives here instead.
//
// VERBATIM, not a paraphrase: the body deleted by cc1c6d213a, recoverable with
// `git show cc1c6d213a^:src/shared/linear-links.ts`. The only edit is reading
// the hostname from the constant the module still exports — which is what the
// surviving twin half (`getLinearOrganizationUrlKeyFromIssueUrl`) does at HEAD.
const LINEAR_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

function twinParseLinearIssueInput(input: string): ParsedLinearIssueInput | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  if (LINEAR_IDENTIFIER_PATTERN.test(trimmed)) {
    return { identifier: trimmed.toUpperCase() }
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.hostname !== LINEAR_APP_HOSTNAME) {
      return null
    }
    const parts = parsed.pathname.split('/').filter(Boolean)
    const issueIndex = parts.indexOf('issue')
    const organizationUrlKey = parts[0]
    const rawIdentifier = issueIndex !== -1 ? parts[issueIndex + 1] : undefined
    if (!organizationUrlKey || !rawIdentifier) {
      return null
    }
    const identifier = decodeURIComponent(rawIdentifier).split(/[/?#]/)[0]
    if (!LINEAR_IDENTIFIER_PATTERN.test(identifier)) {
      return null
    }
    return {
      identifier: identifier.toUpperCase(),
      organizationUrlKey: decodeURIComponent(organizationUrlKey)
    }
  } catch {
    return null
  }
}

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
      // The Rust adapter reads a non-string input as `""`; match that so the
      // comparison stays about the parse, not about the payload shape.
      return twinParseLinearIssueInput(typeof input === 'string' ? input : '')
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
