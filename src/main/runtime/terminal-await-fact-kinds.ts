/**
 * What actually produces each terminal side-effect fact kind — the table
 * `terminal.await` answers from so it can never advertise a kind this runtime
 * posture cannot emit (§5.5 "never a silent downgrade" in
 * docs/reference/alab-auto-mode-design.md).
 *
 *  • `always` — derived from state main computes for every PTY it parses, so it
 *    reaches the journal whether or not a renderer is attached.
 *  • `consumer` — minted by per-chunk scanners main builds only while a renderer
 *    side-effect consumer is attached (the deliberate headless-perf skip). Under
 *    `orca serve` nothing emits these at all.
 *  • `health` — also a per-chunk scanner, but armed per health-relevant PTY
 *    rather than per renderer, which §5.3 sanctions explicitly. A fleet running
 *    headlessly is exactly where these matter, so gating them on a window would
 *    make them unreachable in their own use case.
 *  • `withheld` — never journalled: spinner repaints churn titles ~12.5x/sec and
 *    would evict every real transition from the bounded journal.
 *
 * Its own module because both the pure await loop and the runtime that owns the
 * scanner gate read it, and neither may import the other.
 */

import type { TerminalSideEffectFact } from '../../shared/terminal-side-effect-facts'

export type TerminalAwaitFactProducer = 'always' | 'consumer' | 'health' | 'withheld'

/** The `satisfies` is the drift guard: a new fact kind will not compile until
 *  it is classified here. */
const TERMINAL_AWAIT_FACT_KIND_PRODUCERS = {
  title: 'withheld',
  bell: 'consumer',
  'agent-working': 'always',
  'agent-idle': 'always',
  'agent-exited': 'always',
  'command-finished': 'consumer',
  'pr-link': 'consumer',
  'command-code-working': 'consumer',
  'command-code-done': 'consumer',
  'codex-stream-error': 'consumer',
  '2031-subscribe': 'consumer',
  '2031-unsubscribe': 'consumer',
  'provider-limit': 'health'
} satisfies Record<TerminalSideEffectFact['kind'], TerminalAwaitFactProducer>

function factKindsProducedBy(producer: TerminalAwaitFactProducer): ReadonlySet<string> {
  return new Set(
    Object.entries(TERMINAL_AWAIT_FACT_KIND_PRODUCERS)
      .filter(([, kindProducer]) => kindProducer === producer)
      .map(([kind]) => kind)
  )
}

/** Kinds `terminal.await` accepts at the wire — everything the journal carries. */
export const TERMINAL_AWAIT_AWAITABLE_FACT_KINDS: ReadonlySet<string> = new Set([
  ...factKindsProducedBy('always'),
  ...factKindsProducedBy('consumer'),
  ...factKindsProducedBy('health')
])

/** Kinds that stop being producible when the renderer side-effect consumer goes
 *  away; the runtime answers `unsupported` for them instead of parking. */
export const TERMINAL_AWAIT_CONSUMER_GATED_FACT_KINDS: ReadonlySet<string> =
  factKindsProducedBy('consumer')
