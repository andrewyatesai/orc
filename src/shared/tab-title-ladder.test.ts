// The tab-title twin's suite, moved off the deleted `tab-title-resolution.ts`
// onto the seam shim. Every case runs TWICE — seam unbound (the renderer before
// wasm init, and for the whole session if wasm never lands) and bound to the
// wasm core (what ships once it does) — because the resolved string is a tab's
// visible identity: `TabBar.tsx` feeds it to
// `resolveCommittedTerminalTitleAgentType` and `sync-runtime-graph.ts`
// publishes it to paired mobile clients.
//
// The cases are HEAD's, verbatim, including the AI Vault ones. They are the
// reason this file exists in this shape: a port taken against a working tree
// with the vault step stripped answered `''` where the twin answers the
// conversation name, and no vector in the corpus could see it.
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTerminalTabTitle, resolveUnifiedTabLabel } from './tab-title-ladder'
import { setOrcaDispatchBinding } from './orca-dispatch-seam'
import { orcaDispatch } from '../relay/wasm/orca_git_wasm.js'

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

/** Assert the same throw in both seam states — a non-string slot reaches the
 *  twin's `?.trim()` and the TypeError IS the answer. */
function throwsInBothStates(call: () => unknown, message: RegExp): void {
  setOrcaDispatchBinding(null)
  expect(call).toThrow(message)
  bindWasm()
  expect(call).toThrow(message)
}

/** The raw core answer, with no shim guard in the way. */
function rawCore(fn: string, input: unknown): unknown {
  return JSON.parse(orcaDispatch('tab-title-resolution', fn, JSON.stringify(input)))
}

afterEach(() => setOrcaDispatchBinding(null))

describe('tab title resolution', () => {
  it('uses live terminal titles when generated titles are disabled', () => {
    bothStates(
      () =>
        resolveTerminalTabTitle(
          { customTitle: null, generatedTitle: 'Refactor auth', title: 'Claude working' },
          false
        ),
      'Claude working'
    )
  })

  it('places generated titles between manual and live titles when enabled', () => {
    bothStates(
      () =>
        resolveTerminalTabTitle(
          { customTitle: null, generatedTitle: 'Refactor auth', title: 'Claude working' },
          true
        ),
      'Refactor auth'
    )
    bothStates(
      () =>
        resolveTerminalTabTitle(
          { customTitle: 'Payments', generatedTitle: 'Refactor auth', title: 'Claude working' },
          true
        ),
      'Payments'
    )
  })

  it('uses meaningful native OpenCode session titles before generated titles', () => {
    bothStates(
      () =>
        resolveTerminalTabTitle(
          {
            customTitle: null,
            generatedTitle: 'Refactor auth',
            title: 'OC | Native Stable Session'
          },
          true
        ),
      'OC | Native Stable Session'
    )
  })

  it('keeps generated titles ahead of generic OpenCode titles', () => {
    bothStates(
      () =>
        resolveTerminalTabTitle(
          { customTitle: null, generatedTitle: 'Refactor auth', title: 'OpenCode' },
          true
        ),
      'Refactor auth'
    )
  })

  it('places quick command labels between manual and generated titles', () => {
    bothStates(
      () =>
        resolveTerminalTabTitle(
          {
            customTitle: null,
            quickCommandLabel: 'Run tests',
            generatedTitle: 'Refactor auth',
            title: 'pnpm test'
          },
          true
        ),
      'Run tests'
    )
    bothStates(
      () =>
        resolveTerminalTabTitle(
          {
            customTitle: 'Manual label',
            quickCommandLabel: 'Run tests',
            generatedTitle: 'Refactor auth',
            title: 'pnpm test'
          },
          true
        ),
      'Manual label'
    )
  })

  it('keeps a Codex thread name stable across activity plus project OSC titles', () => {
    // Hoisted to a const rather than written inline only so the vault record
    // keeps its real agent/session fields: the parts type reads `.title`.
    const aiVaultTitle = {
      agent: 'codex' as const,
      sessionId: 'codex-session',
      title: 'Repair provider-native tab titles'
    }
    bothStates(
      () =>
        resolveTerminalTabTitle({ customTitle: null, aiVaultTitle, title: '⠋ albacore' }, false),
      'Repair provider-native tab titles'
    )
  })

  it('keeps manual and quick-command labels ahead of AI Vault titles', () => {
    const aiVaultTitle = {
      agent: 'claude' as const,
      sessionId: 'claude-session',
      title: 'Claude conversation'
    }
    bothStates(
      () =>
        resolveTerminalTabTitle(
          {
            customTitle: 'Manual label',
            quickCommandLabel: 'Run tests',
            aiVaultTitle,
            title: 'claude working'
          },
          false
        ),
      'Manual label'
    )
    bothStates(
      () =>
        resolveTerminalTabTitle(
          {
            customTitle: null,
            quickCommandLabel: 'Run tests',
            aiVaultTitle,
            title: 'claude working'
          },
          false
        ),
      'Run tests'
    )
  })

  it('keeps OpenCode native and Orca-generated title behavior intact', () => {
    const aiVaultTitle = {
      agent: 'codex' as const,
      sessionId: 'codex-session',
      title: 'Codex conversation'
    }
    bothStates(
      () =>
        resolveTerminalTabTitle(
          {
            customTitle: null,
            aiVaultTitle,
            generatedTitle: 'Orca generated',
            title: 'OC | OpenCode native'
          },
          true
        ),
      'OC | OpenCode native'
    )
    bothStates(
      () =>
        resolveTerminalTabTitle(
          { customTitle: null, generatedTitle: 'Orca generated', title: '⠋ albacore' },
          true
        ),
      'Orca generated'
    )
  })

  it('uses the same priority for unified tab labels', () => {
    bothStates(
      () =>
        resolveUnifiedTabLabel(
          { customLabel: null, generatedLabel: 'Fix flaky tests', label: 'Codex working' },
          true
        ),
      'Fix flaky tests'
    )
  })

  it('uses quick command labels before generated unified labels', () => {
    bothStates(
      () =>
        resolveUnifiedTabLabel(
          {
            customLabel: null,
            quickCommandLabel: 'Run build',
            generatedLabel: 'Fix flaky tests',
            label: 'Codex working'
          },
          true
        ),
      'Run build'
    )
  })

  it('uses meaningful native OpenCode labels before generated unified labels', () => {
    bothStates(
      () =>
        resolveUnifiedTabLabel(
          {
            customLabel: null,
            generatedLabel: 'Fix flaky tests',
            label: 'OC | Native Stable Session'
          },
          true
        ),
      'OC | Native Stable Session'
    )
  })

  it('keeps manual and quick command labels ahead of native OpenCode labels', () => {
    bothStates(
      () =>
        resolveUnifiedTabLabel(
          {
            customLabel: 'Manual label',
            quickCommandLabel: 'Run build',
            generatedLabel: 'Fix flaky tests',
            label: 'OC | Native Stable Session'
          },
          true
        ),
      'Manual label'
    )
    bothStates(
      () =>
        resolveUnifiedTabLabel(
          {
            customLabel: null,
            quickCommandLabel: 'Run build',
            generatedLabel: 'Fix flaky tests',
            label: 'OC | Native Stable Session'
          },
          true
        ),
      'Run build'
    )
  })

  it('takes the vault title ahead of the generated unified label', () => {
    const aiVaultTitle = { agent: 'claude' as const, sessionId: 's', title: 'Vault conversation' }
    bothStates(
      () =>
        resolveUnifiedTabLabel(
          {
            customLabel: null,
            aiVaultTitle,
            generatedLabel: 'Fix flaky tests',
            label: 'Codex working'
          },
          true
        ),
      'Vault conversation'
    )
  })

  it('answers the fallback for an absent unified tab', () => {
    bothStates(() => resolveUnifiedTabLabel(undefined, true, 'Untitled'), 'Untitled')
    bothStates(() => resolveUnifiedTabLabel(undefined, true), '')
  })
})

// The divergences a fallback-vs-core differential structurally cannot see: each
// input below reaches the twin's `?.trim()` (or its default-parameter return)
// one way and the adapter's `Value::as_str`/`as_bool` another. Every case pins
// the twin's answer in BOTH seam states AND asserts the raw core would have
// answered differently, so the day the adapter learns to read these the second
// half turns red and the guard is re-derived instead of outliving its reason.
describe('inputs the core adapter reads differently from the twin', () => {
  it('a non-string live title throws the twin TypeError, bound and unbound', () => {
    throwsInBothStates(
      () => resolveTerminalTabTitle({ customTitle: null, title: 42 as never }, false, 'FB'),
      /is not a function/
    )
    expect(
      rawCore('resolveTerminalTabTitle', {
        tab: { customTitle: null, title: 42 },
        generatedTitlesEnabled: false,
        fallback: 'FB'
      })
    ).toBe('FB')
  })

  it('a vault record with no title throws, rather than skipping the step', () => {
    throwsInBothStates(
      () =>
        resolveTerminalTabTitle(
          { customTitle: null, aiVaultTitle: {} as never, title: 'live' },
          false
        ),
      /Cannot read properties of undefined/
    )
    expect(
      rawCore('resolveTerminalTabTitle', {
        tab: { customTitle: null, aiVaultTitle: {}, title: 'live' },
        generatedTitlesEnabled: false,
        fallback: ''
      })
    ).toBe('live')
  })

  it('a truthy non-boolean flag still enables the generated title', () => {
    bothStates(
      () =>
        resolveTerminalTabTitle(
          { customTitle: null, generatedTitle: 'Generated', title: '' },
          1 as never,
          'FB'
        ),
      'Generated'
    )
    // `as_bool` answers None for a number and the port applies `false`.
    expect(
      rawCore('resolveTerminalTabTitle', {
        tab: { customTitle: null, generatedTitle: 'Generated', title: '' },
        generatedTitlesEnabled: 1,
        fallback: 'FB'
      })
    ).toBe('FB')
  })

  it('a non-string fallback comes back unchanged, as the twin returned it', () => {
    bothStates(
      () => resolveTerminalTabTitle({ customTitle: null, title: '' }, false, 7 as never),
      7 as never
    )
    expect(
      rawCore('resolveTerminalTabTitle', {
        tab: { customTitle: null, title: '' },
        generatedTitlesEnabled: false,
        fallback: 7
      })
    ).toBe('')
  })

  it('a lone surrogate answers locally instead of failing the encode', () => {
    // Reachable: a tab title is whatever the PTY wrote in an OSC 0/2 sequence,
    // relayed over SSH; the codec cannot encode an unpaired surrogate.
    bothStates(
      () => resolveTerminalTabTitle({ customTitle: '\ud800x', title: 'live' }, false),
      '\ud800x'
    )
    bothStates(
      () => resolveUnifiedTabLabel({ customLabel: null, label: 'live' }, true, '\udfff pane'),
      'live'
    )
  })
})
