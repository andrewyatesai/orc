// The worktree-ownership shims' PRE-READY CONTRACT gate, and the agent-scratch
// classification pinned in BOTH seam states.
//
// The rows live here rather than in
// `renderer/lib/git-wasm/shim-pre-ready-contract.test.ts` for the same reason
// `workspace-status-normalization` does — that file is already ~2x over its
// max-lines budget — and the mechanism is identical: call each export with the
// seam UNBOUND, call it again BOUND, and require the two to be equal. All eight
// exports declare `parity`; the shim headers say why no sentinel exists for any
// of them.
//
// A fallback-vs-core differential structurally cannot see a divergence that
// only appears once the seam is BOUND: `pnpm parity` drives the shim with no
// binding installed, so every one of its 60 vectors compares the fallback
// against Rust and never the shim's dispatched answer against the twin. This is
// the gate for the one classification whose loss is a user-visible regression —
// `false` here un-hides every `.claude/worktrees/agent-*` row in the sidebar,
// which is what #9535 and #9388 fixed.
//
// It is also the gate on the input the shim reshapes: the twin took a CLOSURE
// (`agentScratchWorktreePathMatcher`) and the shim takes the checkout paths, so
// the bound half proves the array the shim sends rebuilds the same matcher
// inside the core, not just inside the fallback.
//
// Watched failing first, per the repo's rule: dropping `agentScratchCheckoutPaths`
// from the payload in `worktree-ownership-policy.ts` turns the linked-checkout
// rows `external`/visible in the BOUND block while the unbound block stays
// green — exactly the asymmetry this file exists to catch.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import {
  buildKnownOrcaWorkspaceLayouts,
  type WorkspaceLayoutSettings
} from './orca-workspace-layouts'
import { isOrcaDispatchReady, setOrcaDispatchBinding } from './orca-dispatch-seam'
import {
  applyMetadataFallbackVisibility,
  areRuntimePathsEqual,
  classifyWorktreeOwnership,
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility,
  shouldShowWorktree,
  toDetectedWorktree
} from './worktree-ownership-policy'
import type { Repo, Worktree } from './types'

const REPO_PATH = '/repos/app'
const LINKED_CHECKOUT = '/orca/workspaces/app/feature-x'
const REPO_SCRATCH = `${REPO_PATH}/.claude/worktrees/agent-a04ccaaa55ddadb91`
const LINKED_SCRATCH = `${LINKED_CHECKOUT}/.claude/worktrees/agent-a04ccaaa`
const GSD_SCRATCH = `${REPO_PATH}/.gsd-workspaces/phase-1-subagent-2`

const SETTINGS: WorkspaceLayoutSettings = {
  workspaceDir: '/orca/workspaces',
  nestWorkspaces: true,
  workspaceDirHistory: []
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: REPO_PATH,
    displayName: 'app',
    badgeColor: '#000',
    addedAt: Date.UTC(2026, 5, 1),
    kind: 'git',
    ...overrides
  } as Repo
}

function makeWorktree(path: string): Worktree {
  return { id: `repo-1::${path}`, repoId: 'repo-1', path, isMainWorktree: false } as Worktree
}

/** Every scratch answer the sidebar depends on, as one comparable snapshot. */
function scratchAnswers(): string {
  const repo = makeRepo()
  const importedRepo = makeRepo({
    externalWorktreeVisibility: 'hide',
    importedExternalWorktreePaths: [REPO_SCRATCH]
  })
  const knownOrcaLayouts = buildKnownOrcaWorkspaceLayouts(SETTINGS, repo)
  const agentScratchCheckoutPaths = [REPO_PATH, LINKED_CHECKOUT]
  const detect = (path: string, forRepo = repo, paths?: readonly string[]) =>
    toDetectedWorktree({
      repo: forRepo,
      worktree: makeWorktree(path),
      knownOrcaLayouts,
      agentScratchCheckoutPaths: paths
    })
  return JSON.stringify({
    // The repo root alone, i.e. no matcher: the twin's `?? isAgentScratchWorktreePath` arm.
    repoRootScratch: classifyWorktreeOwnership({
      repo,
      worktree: makeWorktree(REPO_SCRATCH),
      knownOrcaLayouts
    }),
    gsdScratch: classifyWorktreeOwnership({
      repo,
      worktree: makeWorktree(GSD_SCRATCH),
      knownOrcaLayouts
    }),
    // Only a registered checkout anchors a scratch dir, so the same path is
    // scratch with the linked checkout in the set and external without it.
    linkedScratchWithCheckouts: classifyWorktreeOwnership({
      repo,
      worktree: makeWorktree(LINKED_SCRATCH),
      knownOrcaLayouts,
      agentScratchCheckoutPaths
    }),
    linkedScratchWithoutCheckouts: classifyWorktreeOwnership({
      repo,
      worktree: makeWorktree(LINKED_SCRATCH),
      knownOrcaLayouts
    }),
    // `[]` is a real matcher that matches nothing — NOT the absent-matcher fallback.
    emptyCheckouts: classifyWorktreeOwnership({
      repo,
      worktree: makeWorktree(REPO_SCRATCH),
      knownOrcaLayouts,
      agentScratchCheckoutPaths: []
    }),
    // Strong metadata still outranks the path match.
    metadataWins: classifyWorktreeOwnership({
      repo,
      worktree: makeWorktree(REPO_SCRATCH),
      meta: { orcaCreatedAt: 1 } as never,
      knownOrcaLayouts
    }),
    // A repo that itself lives under a scratch-looking parent owns real worktrees.
    repoUnderScratchParent: classifyWorktreeOwnership({
      repo: makeRepo({ path: '/repos/.claude/worktrees/app' }),
      worktree: makeWorktree('/repos/.claude/worktrees/app/manual/feature-x'),
      knownOrcaLayouts
    }),
    hiddenRow: detect(REPO_SCRATCH),
    hiddenLinkedRow: detect(LINKED_SCRATCH, repo, agentScratchCheckoutPaths),
    // The explicit-import override outranks the scratch rule, and survives the
    // metadata fallback by reference.
    importedRow: detect(REPO_SCRATCH, importedRepo),
    importedRowAfterFallback: applyMetadataFallbackVisibility(detect(REPO_SCRATCH, importedRepo)),
    hiddenRowAfterFallback: applyMetadataFallbackVisibility(detect(REPO_SCRATCH))
  })
}

const EXPECTED_SCRATCH_ANSWERS = JSON.stringify({
  repoRootScratch: 'agent-scratch',
  gsdScratch: 'agent-scratch',
  linkedScratchWithCheckouts: 'agent-scratch',
  linkedScratchWithoutCheckouts: 'external',
  // Not scratch, so the layout heuristics run and a path under no known root
  // is external — the point is that neither is `agent-scratch`.
  emptyCheckouts: 'external',
  metadataWins: 'orca-managed',
  repoUnderScratchParent: 'external',
  hiddenRow: {
    id: `repo-1::${REPO_SCRATCH}`,
    repoId: 'repo-1',
    path: REPO_SCRATCH,
    isMainWorktree: false,
    ownership: 'agent-scratch',
    selectedCheckout: false,
    visible: false
  },
  hiddenLinkedRow: {
    id: `repo-1::${LINKED_SCRATCH}`,
    repoId: 'repo-1',
    path: LINKED_SCRATCH,
    isMainWorktree: false,
    ownership: 'agent-scratch',
    selectedCheckout: false,
    visible: false
  },
  importedRow: {
    id: `repo-1::${REPO_SCRATCH}`,
    repoId: 'repo-1',
    path: REPO_SCRATCH,
    isMainWorktree: false,
    ownership: 'agent-scratch',
    selectedCheckout: false,
    visible: true
  },
  importedRowAfterFallback: {
    id: `repo-1::${REPO_SCRATCH}`,
    repoId: 'repo-1',
    path: REPO_SCRATCH,
    isMainWorktree: false,
    ownership: 'agent-scratch',
    selectedCheckout: false,
    visible: true
  },
  hiddenRowAfterFallback: {
    id: `repo-1::${REPO_SCRATCH}`,
    repoId: 'repo-1',
    path: REPO_SCRATCH,
    isMainWorktree: false,
    ownership: 'agent-scratch',
    selectedCheckout: false,
    visible: false
  }
})

const BOUND = (module: string, fn: string, input: string) => orcaDispatch(module, fn, input)

// config/vitest-orca-dispatch-seam.ts already ran initSync and bound the seam;
// restore that so the file leaves the process the way it found it.
afterAll(() => setOrcaDispatchBinding(BOUND))

describe('agent-scratch classification in both seam states', () => {
  beforeEach(() => setOrcaDispatchBinding(null))

  it('unbound — the shim answers the twin from its parity fallback', () => {
    expect(isOrcaDispatchReady()).toBe(false)
    expect(scratchAnswers()).toBe(EXPECTED_SCRATCH_ANSWERS)
  })

  it('bound — the Rust core answers the same thing', () => {
    setOrcaDispatchBinding(BOUND)
    expect(isOrcaDispatchReady()).toBe(true)
    expect(scratchAnswers()).toBe(EXPECTED_SCRATCH_ANSWERS)
  })

  it('the scratch row keeps its identity through the metadata fallback in both states', () => {
    const row = toDetectedWorktree({
      repo: makeRepo({ importedExternalWorktreePaths: [REPO_SCRATCH] }),
      worktree: makeWorktree(REPO_SCRATCH),
      knownOrcaLayouts: []
    })
    expect(applyMetadataFallbackVisibility(row)).toBe(row)
    setOrcaDispatchBinding(BOUND)
    expect(applyMetadataFallbackVisibility(row)).toBe(row)
  })
})

/** One row per exported function; `why` is the declaration, not decoration. */
const PRE_READY_CASES: { name: string; call: () => unknown; why: string }[] = [
  {
    name: 'orca-workspace-layouts.buildKnownOrcaWorkspaceLayouts',
    call: () =>
      buildKnownOrcaWorkspaceLayouts(
        {
          workspaceDir: '/orca/workspaces',
          nestWorkspaces: true,
          workspaceDirHistory: [{ path: '/old/workspaces', nestWorkspaces: false }]
        },
        { path: REPO_PATH, worktreeBasePath: '../worktrees' }
      ),
    why: 'these ARE the roots every ownership decision is compared against; an empty pre-ready list turns every external worktree into unknown-legacy, which a legacy repo then shows'
  },
  {
    name: 'worktree-ownership-policy.isLegacyRepoForExternalWorktreeVisibility',
    call: () =>
      isLegacyRepoForExternalWorktreeVisibility(makeRepo({ externalWorktreeVisibility: 'hide' })),
    why: 'persistence.ts stamps this flag onto the repo record, so a pre-ready guess is written to disk'
  },
  {
    name: 'worktree-ownership-policy.effectiveExternalWorktreeVisibility',
    call: () => effectiveExternalWorktreeVisibility({}, false),
    why: "'hide' is the twin's real answer for a new repo with no setting, not a signal — the sidebar and the visibility dialog both render off it"
  },
  {
    name: 'worktree-ownership-policy.classifyWorktreeOwnership(agent scratch)',
    call: () =>
      classifyWorktreeOwnership({
        repo: { path: REPO_PATH },
        worktree: makeWorktree(REPO_SCRATCH),
        knownOrcaLayouts: []
      }),
    why: 'the regression this module exists to prevent: anything but agent-scratch un-hides every sub-agent worktree'
  },
  {
    name: 'worktree-ownership-policy.classifyWorktreeOwnership(external)',
    call: () =>
      classifyWorktreeOwnership({
        repo: { path: REPO_PATH },
        worktree: makeWorktree(`${LINKED_CHECKOUT}/x`),
        knownOrcaLayouts: [{ path: '/orca/workspaces', nestWorkspaces: true }]
      }),
    why: 'the layout arm, where a degraded answer silently reclassifies a real workspace'
  },
  {
    name: 'worktree-ownership-policy.toDetectedWorktree',
    call: () =>
      toDetectedWorktree({
        repo: makeRepo({ externalWorktreeVisibility: 'hide' }),
        worktree: makeWorktree(REPO_SCRATCH),
        knownOrcaLayouts: []
      }),
    why: 'the whole row; the spread is TypeScript on both paths, so only the three decided fields can differ — and `visible: true` pre-ready is a scratch row on screen'
  },
  {
    name: 'worktree-ownership-policy.shouldShowWorktree(imported scratch)',
    call: () =>
      shouldShowWorktree({
        worktree: { path: REPO_SCRATCH },
        ownership: 'agent-scratch',
        repo: { externalWorktreeVisibility: 'hide' },
        isLegacyRepoForVisibility: false,
        isSelectedCheckout: false,
        importedExternalWorktreePaths: [REPO_SCRATCH]
      }),
    why: 'the explicit-import override outranking the scratch rule — a row the user imported must not vanish while the core loads'
  },
  {
    name: 'worktree-ownership-policy.applyMetadataFallbackVisibility(external)',
    call: () =>
      applyMetadataFallbackVisibility({
        ...makeWorktree('/scratch/manual'),
        ownership: 'external',
        selectedCheckout: false,
        visible: false
      }),
    why: 'it runs only when the git scan already FAILED, so it is the last evidence there is'
  },
  {
    name: 'worktree-ownership-policy.areRuntimePathsEqual',
    call: () => areRuntimePathsEqual('C:\\Repos\\App', 'c:/repos/app'),
    why: 'it decides selectedCheckout, the one thing that keeps the current workspace visible under any visibility setting'
  }
]

// Computed before anything rebinds, exactly as the renderer gate does it.
setOrcaDispatchBinding(null)
const PRE_READY = PRE_READY_CASES.map((testCase) => JSON.stringify(testCase.call()) ?? 'undefined')
setOrcaDispatchBinding(BOUND)

describe('worktree-ownership pre-ready contract', () => {
  PRE_READY_CASES.forEach((testCase, index) => {
    it(`${testCase.name} — pre-ready matches ready (${testCase.why})`, () => {
      setOrcaDispatchBinding(BOUND)
      expect(PRE_READY[index]).toBe(JSON.stringify(testCase.call()) ?? 'undefined')
    })
  })
})
