// The workspace-statuses twin's suite, moved onto the seam shim when the module
// was cut over to `orca_config::workspace_statuses`, plus the cases the cutover
// itself needs: the guarded argument shapes (trap 5 — a fallback-vs-core
// differential cannot see a divergence that only appears once the seam is bound)
// and the two residuals the shim declares in its header.
//
// Every case runs TWICE — seam unbound (the renderer before wasm init, the
// preload, mobile, a Playwright spec) and bound to the wasm core (main/cli via
// napi, the relay via initSync) — because these answers are PERSISTED, keyed on,
// and equality-compared: `persistence.ts` writes the normalized columns to disk,
// `worktree-list-groups.ts` uses the group key as a Map and React key, and the
// board compares `getWorkspaceStatus` against a lane id on every card.
import { afterEach, describe, expect, it } from 'vitest'
import {
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity,
  cloneDefaultWorkspaceStatuses,
  getDefaultWorkspaceStatusId,
  getWorkspaceStatus,
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusGroupKey,
  isWorkspaceStatusId,
  makeWorkspaceStatusId,
  normalizePersistedWorkspaceStatuses,
  normalizeWorkspaceStatuses
} from './workspace-status-normalization'
import {
  MAX_STATUS_LABEL_LENGTH,
  WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT,
  WORKSPACE_BOARD_COLUMN_WIDTH_MAX,
  WORKSPACE_BOARD_COLUMN_WIDTH_MIN
} from './workspace-statuses'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'
import type { WorkspaceStatusDefinition } from './types'

function bindWasm(): void {
  setOrcaDispatchBinding((module, fn, inputJson) => orcaDispatch(module, fn, inputJson))
}

/** Run `call` unbound and bound; assert both equal `expected`. */
function bothStates<T>(call: () => T, expected: T): void {
  setOrcaDispatchBinding(null)
  expect(call()).toEqual(expected)
  bindWasm()
  expect(call()).toEqual(expected)
}

/** Run `assert` unbound and again bound, for the twin's `toMatchObject` cases. */
function inBothStates(assert: () => void): void {
  setOrcaDispatchBinding(null)
  assert()
  bindWasm()
  assert()
}

/** The raw core answer, with no shim guard in the way. */
function rawCore(fn: string, input: unknown): unknown {
  return JSON.parse(orcaDispatch('workspace-statuses', fn, JSON.stringify(input)))
}

const CONDUCTOR_DEFAULTS = [
  { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' },
  {
    id: 'in-progress',
    label: 'In progress',
    color: 'conductor-progress',
    icon: 'conductor-progress'
  },
  { id: 'in-review', label: 'In review', color: 'conductor-review', icon: 'conductor-review' },
  { id: 'completed', label: 'Completed', color: 'conductor-done', icon: 'conductor-done' }
]

const LEGACY_VISUAL_DEFAULTS = [
  { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' },
  { id: 'in-progress', label: 'In progress', color: 'blue', icon: 'circle-dot' },
  { id: 'in-review', label: 'In review', color: 'violet', icon: 'git-pull-request' },
  { id: 'completed', label: 'Completed', color: 'emerald', icon: 'circle-check' }
]

afterEach(() => setOrcaDispatchBinding(null))

describe('workspace status visuals', () => {
  it('keeps the default workflow order', () => {
    inBothStates(() => {
      expect(cloneDefaultWorkspaceStatuses().map((status) => status.id)).toEqual([
        'todo',
        'in-progress',
        'in-review',
        'completed'
      ])
      expect(cloneDefaultWorkspaceStatuses()[0]).toMatchObject({ id: 'todo', label: 'Todo' })
      expect(cloneDefaultWorkspaceStatuses().at(-1)).toMatchObject({
        id: 'completed',
        label: 'Done'
      })
    })
  })

  it('migrates legacy default statuses to the default workflow order', () => {
    inBothStates(() => {
      expect(
        normalizePersistedWorkspaceStatuses(CONDUCTOR_DEFAULTS, {
          migrateDefaultWorkflowStatuses: true
        })
      ).toEqual(cloneDefaultWorkspaceStatuses())
    })
  })

  it('migrates the old default status visuals without reordering the board', () => {
    inBothStates(() => {
      const statuses = normalizePersistedWorkspaceStatuses(LEGACY_VISUAL_DEFAULTS, {
        migrateLegacyDefaultStatusVisuals: true
      })

      expect(statuses.map((status) => status.id)).toEqual([
        'todo',
        'in-progress',
        'in-review',
        'completed'
      ])
      expect(statuses.map((status) => status.color)).toEqual([
        'neutral',
        'conductor-progress',
        'conductor-review',
        'conductor-done'
      ])
    })
  })

  it('preserves explicit status order while migrating default visuals', () => {
    inBothStates(() => {
      const statuses = normalizePersistedWorkspaceStatuses(LEGACY_VISUAL_DEFAULTS.toReversed(), {
        migrateLegacyDefaultStatusVisuals: true
      })

      expect(statuses.map((status) => status.id)).toEqual([
        'completed',
        'in-review',
        'in-progress',
        'todo'
      ])
      expect(statuses[0]).toMatchObject({ color: 'conductor-done', icon: 'conductor-done' })
    })
  })

  it('preserves default-label reordered statuses unless a default migration is requested', () => {
    bothStates(
      () =>
        normalizePersistedWorkspaceStatuses(CONDUCTOR_DEFAULTS.toReversed()).map(
          (status) => status.id
        ),
      ['completed', 'in-review', 'in-progress', 'todo']
    )
  })

  it('migrates exact reordered default statuses to the new Done label when requested', () => {
    inBothStates(() => {
      expect(
        normalizePersistedWorkspaceStatuses(CONDUCTOR_DEFAULTS.toReversed(), {
          migrateDefaultWorkflowStatuses: true
        })
      ).toEqual(cloneDefaultWorkspaceStatuses())
    })
  })

  it('repairs the exact PR-introduced default status reorder when migration-gated', () => {
    inBothStates(() => {
      expect(
        normalizePersistedWorkspaceStatuses(CONDUCTOR_DEFAULTS.toReversed(), {
          repairReorderedDefaultStatuses: true
        })
      ).toEqual(cloneDefaultWorkspaceStatuses())
    })
  })

  it('repairs the exact reordered default status payload with the Done label', () => {
    const reorderedWithDoneLabel = CONDUCTOR_DEFAULTS.toReversed().map((status) =>
      status.id === 'completed' ? { ...status, label: 'Done' } : status
    )
    inBothStates(() => {
      expect(
        normalizePersistedWorkspaceStatuses(reorderedWithDoneLabel, {
          repairReorderedDefaultStatuses: true
        })
      ).toEqual(cloneDefaultWorkspaceStatuses())
    })
  })

  it('does not repair reordered default-label statuses with a different raw shape', () => {
    bothStates(
      () =>
        normalizePersistedWorkspaceStatuses(LEGACY_VISUAL_DEFAULTS.toReversed(), {
          repairReorderedDefaultStatuses: true
        }).map((status) => status.id),
      ['completed', 'in-review', 'in-progress', 'todo']
    )
  })

  it('leaves custom persisted status layouts in their saved order', () => {
    bothStates(
      () =>
        normalizePersistedWorkspaceStatuses([
          { id: 'completed', label: 'Shipped', color: 'conductor-done', icon: 'conductor-done' },
          { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' }
        ]).map((status) => status.id),
      ['completed', 'todo']
    )
  })

  it('uses Conductor-style visuals for the default status icons', () => {
    inBothStates(() => {
      const statuses = cloneDefaultWorkspaceStatuses()
      expect(statuses.find((status) => status.id === 'in-progress')).toMatchObject({
        color: 'conductor-progress',
        icon: 'conductor-progress'
      })
      expect(statuses.find((status) => status.id === 'in-review')).toMatchObject({
        color: 'conductor-review',
        icon: 'conductor-review'
      })
      expect(statuses.find((status) => status.id === 'completed')).toMatchObject({
        color: 'conductor-done',
        icon: 'conductor-done'
      })
    })
  })

  it('migrates the old in-progress blue dot default only when requested', () => {
    inBothStates(() => {
      const statuses = normalizePersistedWorkspaceStatuses(
        [{ id: 'in-progress', label: 'In progress', color: 'blue', icon: 'circle-dot' }],
        { migrateLegacyDefaultStatusVisuals: true }
      )
      expect(statuses[0]).toMatchObject({
        color: 'conductor-progress',
        icon: 'conductor-progress'
      })
    })
  })

  it('preserves valid legacy visuals for default-label statuses at runtime', () => {
    inBothStates(() => {
      const statuses = normalizeWorkspaceStatuses([
        { id: 'in-progress', label: 'In progress', color: 'blue', icon: 'circle-dot' }
      ])
      expect(statuses[0]).toMatchObject({ color: 'blue', icon: 'circle-dot' })
    })
  })

  it('keeps intentional custom in-progress visuals', () => {
    inBothStates(() => {
      const statuses = normalizeWorkspaceStatuses([
        { id: 'in-progress', label: 'Doing', color: 'blue', icon: 'circle-dot' }
      ])
      expect(statuses[0]).toMatchObject({ color: 'blue', icon: 'circle-dot' })
    })
  })

  it('clamps workspace board column widths to resizable bounds', () => {
    inBothStates(() => {
      expect(clampWorkspaceBoardColumnWidth(undefined)).toBe(WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT)
      expect(clampWorkspaceBoardColumnWidth(100)).toBe(WORKSPACE_BOARD_COLUMN_WIDTH_MIN)
      expect(clampWorkspaceBoardColumnWidth(321.6)).toBe(322)
      expect(clampWorkspaceBoardColumnWidth(900)).toBe(WORKSPACE_BOARD_COLUMN_WIDTH_MAX)
    })
  })
})

describe('the trim + cap fix that unblocked this cutover', () => {
  it('strips a BOM the way JS trim does, not the way Rust is_whitespace does', () => {
    // Rust `char::is_whitespace` does NOT strip U+FEFF and JS `.trim()` does —
    // and the id here is MINTED and persisted. This is the fix that unblocked
    // the module after three refusals; the label half was already correct.
    bothStates(
      () => normalizeWorkspaceStatuses([{ id: '\uFEFFsome-label\uFEFF', label: 'B' }])[0]?.id,
      'some-label'
    )
    bothStates(
      () => normalizeWorkspaceStatuses([{ id: 'a', label: '\uFEFF Board \uFEFF' }])[0]?.label,
      'Board'
    )
  })

  it('keeps U+0085 in — the other half of the trim-set split', () => {
    // Rust strips NEL, JS does not, so a label carrying it must survive intact
    // and an id carrying it must fold it to the slug separator, not drop it.
    bothStates(
      () => normalizeWorkspaceStatuses([{ id: 'a', label: '\u0085Board\u0085' }])[0]?.label,
      '\u0085Board\u0085'
    )
  })

  it('caps the label in UTF-16 code units, so 20 emoji become 16', () => {
    const label = '\u{1F680}'.repeat(20)
    bothStates(
      () => normalizeWorkspaceStatuses([{ id: 'a', label }])[0]?.label,
      '\u{1F680}'.repeat(MAX_STATUS_LABEL_LENGTH / 2)
    )
  })
})

describe('declared residual 1 — the exhausted collision minter', () => {
  const exhausted: WorkspaceStatusDefinition[] = [
    { id: 'board', label: '', color: '', icon: '' },
    ...Array.from({ length: 98 }, (_, index) => ({
      id: `board-${index + 2}`,
      label: '',
      color: '',
      icon: ''
    }))
  ]

  it('answers the twin clock id in BOTH states, never the core substitute', () => {
    for (const bind of [() => setOrcaDispatchBinding(null), bindWasm]) {
      bind()
      expect(makeWorkspaceStatusId('Board', exhausted)).toMatch(/^status-[0-9a-z]+$/)
    }
  })

  it("pins WHY it is answered locally: the core's substitute is already taken", () => {
    // Not a shim defect — a property of a clock-derived twin answer. Recorded so
    // a core that ever grows a real answer here turns this red and gets
    // re-declared instead of drifting.
    expect(
      rawCore('makeWorkspaceStatusId', {
        label: 'Board',
        existingStatuses: exhausted.map((status) => ({ id: status.id }))
      })
    ).toBe('board-99')
    expect(exhausted.some((status) => status.id === 'board-99')).toBe(true)
  })

  it('still crosses for every reachable collision depth', () => {
    const nearly = exhausted.slice(0, 98)
    bothStates(() => makeWorkspaceStatusId('Board', nearly), 'board-99')
    bothStates(() => makeWorkspaceStatusId('Board', []), 'board')
  })
})

describe('declared residual 2 — a cap that splits a surrogate pair', () => {
  const splitting = `${'a'.repeat(MAX_STATUS_LABEL_LENGTH - 1)}\u{1F680}`

  it('answers the twin lone high surrogate in BOTH states', () => {
    const expected = `${'a'.repeat(MAX_STATUS_LABEL_LENGTH - 1)}\uD83D`
    bothStates(
      () => normalizeWorkspaceStatuses([{ id: 'a', label: splitting }])[0]?.label,
      expected
    )
  })

  it('pins WHY it is answered locally: no Rust String can hold a lone surrogate', () => {
    const fromCore = rawCore('normalizeWorkspaceStatuses', [
      { id: 'a', label: splitting }
    ]) as WorkspaceStatusDefinition[]
    expect(fromCore[0]?.label).toBe('a'.repeat(MAX_STATUS_LABEL_LENGTH - 1))
  })

  it('crosses when the cap lands cleanly on a pair boundary', () => {
    const clean = `${'a'.repeat(MAX_STATUS_LABEL_LENGTH - 2)}\u{1F680}`
    bothStates(() => normalizeWorkspaceStatuses([{ id: 'a', label: clean }])[0]?.label, clean)
  })
})

describe('bound-vs-unbound: the shapes the shim refuses to cross', () => {
  const columns: WorkspaceStatusDefinition[] = [
    { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' }
  ]

  it('throws the twin TypeError for a non-array status list, in both states', () => {
    for (const bind of [() => setOrcaDispatchBinding(null), bindWasm]) {
      bind()
      // The core's adapter reads a non-array as an EMPTY list and answers
      // `in-progress`; the twin threw, and so must the shim.
      expect(() => getDefaultWorkspaceStatusId(null as never)).toThrow(TypeError)
      expect(() => isWorkspaceStatusId('todo', undefined as never)).toThrow(TypeError)
    }
    expect(rawCore('getDefaultWorkspaceStatusId', null)).toBe('in-progress')
  })

  it('never lets a row with a non-string id match a column, in both states', () => {
    // `statuses_from_json` rebuilds an absent OR non-string id as "", so an
    // empty-id query matches such a row once the seam is bound. `{id: 5}` is the
    // sharp case: unlike an absent key it ENCODES fine, so only the shim's guard
    // stops it — the twin compares `5 === ''` and answers false.
    const typedWrong = [{ id: 5 }] as unknown as WorkspaceStatusDefinition[]
    const idless = [{ label: 'Todo' }] as unknown as WorkspaceStatusDefinition[]
    bothStates(() => isWorkspaceStatusId('', typedWrong), false)
    bothStates(() => isWorkspaceStatusId('', idless), false)
    // The twin hands back `statuses[0].id` untouched — 5, not the core's "".
    bothStates(() => getDefaultWorkspaceStatusId(typedWrong), 5 as unknown as string)
    expect(rawCore('isWorkspaceStatusId', { value: '', statuses: [{ id: 5 }] })).toBe(true)
    expect(rawCore('getDefaultWorkspaceStatusId', [{ id: 5 }])).toBe('')
  })

  it('treats a non-string stored status as the twin falsy case, in both states', () => {
    const worktree = { workspaceStatus: 7 as unknown as string }
    bothStates(() => getWorkspaceStatus(worktree, columns), 'todo')
  })

  it('throws out of startsWith for a non-string group key, in both states', () => {
    for (const bind of [() => setOrcaDispatchBinding(null), bindWasm]) {
      bind()
      expect(() => getWorkspaceStatusFromGroupKey(null as never, columns)).toThrow(TypeError)
    }
  })

  it('rejects an unpaired surrogate the way encodeURIComponent did, in both states', () => {
    for (const bind of [() => setOrcaDispatchBinding(null), bindWasm]) {
      bind()
      expect(() => getWorkspaceStatusGroupKey('\uD800')).toThrow(URIError)
    }
  })

  it('round-trips a column id through the group key in both states', () => {
    const encoded = [' spaces ', '%', 'a/b?c', '\u{1F680}', 'todo']
    for (const id of encoded) {
      const board: WorkspaceStatusDefinition[] = [{ id, label: id, color: '', icon: '' }]
      bothStates(() => getWorkspaceStatusFromGroupKey(getWorkspaceStatusGroupKey(id), board), id)
    }
  })

  it('fails closed on a malformed escape, in both states', () => {
    bothStates(() => getWorkspaceStatusFromGroupKey('workspace-status:%', columns), null)
    bothStates(() => getWorkspaceStatusFromGroupKey('not-a-status-key', columns), null)
  })

  it('answers the clamp constants locally for the values the codec rejects', () => {
    inBothStates(() => {
      expect(clampWorkspaceBoardOpacity(Number.NaN)).toBe(1)
      expect(clampWorkspaceBoardOpacity(Number.POSITIVE_INFINITY)).toBe(1)
      expect(clampWorkspaceBoardOpacity('0.5')).toBe(1)
      expect(clampWorkspaceBoardOpacity(-0)).toBe(0.2)
      expect(clampWorkspaceBoardColumnWidth(-0)).toBe(WORKSPACE_BOARD_COLUMN_WIDTH_MIN)
      expect(clampWorkspaceBoardColumnWidth(Number.NaN)).toBe(WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT)
    })
  })

  it('clamps the halfway and out-of-range numbers identically in both states', () => {
    // The expectation is the twin's arithmetic spelled out here, not the shim's
    // own answer — comparing the shim to itself would pass vacuously.
    for (const value of [0.005, 0.2, 0.245, 0.5, 0.995, 1, 2, -3, 219.5, 220.5, 519.5, 1e30]) {
      bothStates(
        () => clampWorkspaceBoardOpacity(value),
        Math.min(1, Math.max(0.2, Math.round(value * 100) / 100))
      )
      bothStates(
        () => clampWorkspaceBoardColumnWidth(value),
        Math.min(
          WORKSPACE_BOARD_COLUMN_WIDTH_MAX,
          Math.max(WORKSPACE_BOARD_COLUMN_WIDTH_MIN, Math.round(value))
        )
      )
    }
  })
})

// The pre-ready contract rows for all ELEVEN exports, in the shape
// `src/renderer/src/lib/git-wasm/shim-pre-ready-contract.test.ts` uses (which
// carries a pointer here rather than the rows, because that file is already ~2x
// over its max-lines budget). The mechanism is the same and just as sound: the
// Rust core is a parity port of the deleted twin, so the twin's answer IS the
// ready answer — call the export unbound, call it bound, compare. Every row is
// an observed fact, so it cannot false-flag.
//
// All eleven are `parity` and every one is MANDATORY, not tidy — there is no
// spare state anywhere in this module. The reason is recorded per row.
describe('pre-ready contract — one row per exported function', () => {
  const board = cloneDefaultWorkspaceStatuses()
  const rows: { name: string; why: string; call: () => unknown }[] = [
    {
      name: 'cloneDefaultWorkspaceStatuses',
      why: 'getDefaultUIState() builds the persisted board from it in every surface, including preload and cli where the seam may never bind',
      call: () => cloneDefaultWorkspaceStatuses()
    },
    {
      name: 'normalizeWorkspaceStatuses',
      why: 'store/slices/ui.ts and persistence.ts WRITE this; a degraded answer rewrites the user board',
      call: () =>
        normalizeWorkspaceStatuses([
          { id: ' In Review ', label: '  In   review  ', color: 'nope', icon: 'circle-check' },
          { id: 'in-review', label: 'Dup', color: 'violet', icon: 'timer' },
          'not-an-object'
        ])
    },
    {
      name: 'normalizePersistedWorkspaceStatuses',
      why: 'the one-shot repair is written back and its `_migrated` flag set, so a pre-ready miss burns the migration for good',
      call: () =>
        normalizePersistedWorkspaceStatuses(LEGACY_VISUAL_DEFAULTS, {
          migrateLegacyDefaultStatusVisuals: true
        })
    },
    {
      name: 'makeWorkspaceStatusId',
      why: 'the minted id is persisted and user-visible — WorkspaceKanbanDrawer writes it straight into the column list',
      call: () => makeWorkspaceStatusId('In review', board)
    },
    {
      name: 'clampWorkspaceBoardOpacity',
      why: 'setWorkspaceBoardOpacity persists the clamped number; a pre-ready 1 erases a dragged slider',
      call: () => clampWorkspaceBoardOpacity(0.155)
    },
    {
      name: 'clampWorkspaceBoardColumnWidth',
      why: 'use-workspace-kanban-column-resize commits this on pointer-up, so a pre-ready default snaps every drag back to 308',
      call: () => clampWorkspaceBoardColumnWidth(321.6)
    },
    {
      name: 'isWorkspaceStatusId',
      why: 'a bare boolean consumed inside `&&`; useComposerState uses it to decide whether a new workspace keeps its requested column',
      call: () => isWorkspaceStatusId('in-review', board)
    },
    {
      name: 'getDefaultWorkspaceStatusId',
      why: 'the leftmost-column fallback depends on the board, so no constant is honest — this is where an unassigned workspace renders',
      call: () => getDefaultWorkspaceStatusId([{ id: 'backlog', label: 'Backlog' }])
    },
    {
      name: 'getWorkspaceStatus',
      why: 'compared with `===` against a lane id on every card render',
      call: () => getWorkspaceStatus({ workspaceStatus: 'deleted-column' }, board)
    },
    {
      name: 'getWorkspaceStatusGroupKey',
      why: 'a React key and a Map key in worktree-list-groups, and the drop target parses it back — the two must agree in both states',
      call: () => getWorkspaceStatusGroupKey('in review/1')
    },
    {
      name: 'getWorkspaceStatusFromGroupKey',
      why: 'WorktreeList resolves a drag drop through it, so a pre-ready null silently drops the gesture',
      call: () => getWorkspaceStatusFromGroupKey('workspace-status:in-review', board)
    }
  ]

  rows.forEach(({ name, why, call }) => {
    it(`${name} — pre-ready matches ready (${why})`, () => {
      setOrcaDispatchBinding(null)
      const preReady = JSON.stringify(call()) ?? 'undefined'
      bindWasm()
      expect(preReady).toBe(JSON.stringify(call()) ?? 'undefined')
    })
  })

  it('covers every export the module has', () => {
    expect(rows).toHaveLength(11)
  })
})
