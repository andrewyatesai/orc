/**
 * Parsing and phase derivation for `[startup]` diagnostic milestone lines
 * (ORCA_STARTUP_DIAGNOSTICS=1 stderr), shared by startup-time-bench.mjs and
 * its unit tests. `t=` details are the in-app ms-since-process-start clock;
 * `harnessMs` is stamped by the harness at stderr arrival (includes pipe
 * jitter, but exists even for lines without `t`).
 */

export function parseStartupLine(line) {
  const match = /^\[startup\] (\S+)(.*)$/.exec(line)
  if (!match) {
    return null
  }
  const details = {}
  const detailText = match[2].trim()
  if (detailText) {
    for (const pair of detailText.match(/(\S+?)=("[^"]*"|\S+)/g) ?? []) {
      const eq = pair.indexOf('=')
      const key = pair.slice(0, eq)
      let value = pair.slice(eq + 1)
      try {
        value = JSON.parse(value)
      } catch {
        // keep raw string
      }
      details[key] = value
    }
  }
  return { event: match[1], details }
}

function eventTime(events, name, key) {
  const entry = events.find((event) => event.event === name)
  if (!entry) {
    return null
  }
  return key === 't'
    ? typeof entry.details.t === 'number'
      ? entry.details.t
      : null
    : entry.harnessMs
}

export function derivePhases(events) {
  const aclStart = eventTime(events, 'acl-grant-start', 't')
  const aclDone = eventTime(events, 'acl-grant-done', 't')
  return {
    startupJsonParseMs: delta(
      events,
      'persistence-json-parse-start',
      'persistence-json-parse-done'
    ),
    startupStoreLoadMs: delta(events, 'persistence-load-start', 'persistence-load-done'),
    spawnToAppReady: eventTime(events, 'app-ready', 'harness'),
    appReadyToServices: delta(events, 'app-ready', 'services-initialized'),
    servicesToI18n: delta(events, 'services-initialized', 'i18n-ready'),
    i18nToOpenWindow: delta(events, 'i18n-ready', 'open-main-window-start'),
    daemonInitMs: delta(events, 'daemon-init-start', 'daemon-init-done'),
    aclGrantMs: aclStart !== null && aclDone !== null ? aclDone - aclStart : null,
    windowCreatedToLoadStart: delta(events, 'window-created', 'load-start'),
    windowCreatedToLoaded: delta(events, 'window-created', 'did-finish-load'),
    totalToWindowCreated: eventTime(events, 'window-created', 'harness'),
    totalToDidFinishLoad: eventTime(events, 'did-finish-load', 'harness'),
    didFinishLoadToWorkspaceReady: delta(
      events,
      'did-finish-load',
      'renderer-startup-hydration-done'
    ),
    totalToWorkspaceReady: eventTime(events, 'renderer-startup-hydration-done', 'harness'),
    // Time-to-first-terminal: the aterm engine cold boot lands after
    // workspace-ready, so this is the first frame a restored pane presents.
    totalToFirstTerminalFrame: eventTime(events, 'renderer-first-terminal-frame', 'harness'),
    workspaceReadyToFirstTerminalFrame: deltaPreferInApp(
      events,
      'renderer-startup-hydration-done',
      'renderer-first-terminal-frame'
    ),
    // The engine cold boot the session-restore warm overlaps, split into its
    // phases so a first-terminal regression names the stage that moved.
    atermWarmStartToWasmReady: deltaPreferInApp(
      events,
      'renderer-aterm-warm-start',
      'renderer-aterm-wasm-ready'
    ),
    atermWasmReadyToWorkerReady: deltaPreferInApp(
      events,
      'renderer-aterm-wasm-ready',
      'renderer-aterm-worker-ready'
    ),
    atermWorkerReadyToFirstTerminalFrame: deltaPreferInApp(
      events,
      'renderer-aterm-worker-ready',
      'renderer-first-terminal-frame'
    ),
    rendererReconnectTerminalsMs:
      eventDetailsNumber(events, 'renderer-reconnect-terminals-done', 'durationMs') ??
      delta(
        events,
        'renderer-first-window-services-await-done',
        'renderer-reconnect-terminals-done'
      ),
    // Worst single main-thread stall observed by the event-loop probe — the
    // direct measurement of issue #7225's "Not Responding" freeze.
    maxEventLoopStallMs: maxEventDetailsNumber(events, 'event-loop-stall', 'maxGapMs')
  }
}

function maxEventDetailsNumber(events, name, key) {
  let max = null
  for (const event of events) {
    if (event.event !== name) {
      continue
    }
    const value = event.details[key]
    if (typeof value === 'number' && (max === null || value > max)) {
      max = value
    }
  }
  return max
}

function eventDetailsNumber(events, name, key) {
  const value = events.find((event) => event.event === name)?.details[key]
  return typeof value === 'number' ? value : null
}

function delta(events, from, to) {
  const a = eventTime(events, from, 't')
  const b = eventTime(events, to, 't')
  return a !== null && b !== null ? b - a : null
}

// Prefer the in-app t= clock (immune to stderr pipe jitter); fall back to
// harness arrival times when either line lost its t detail.
function deltaPreferInApp(events, from, to) {
  // Renderer-originated milestones carry rendererT (one performance.now()
  // clock) — same-clock deltas avoid the IPC-arrival jitter in main's t=.
  const fromRendererT = eventDetailsNumber(events, from, 'rendererT')
  const toRendererT = eventDetailsNumber(events, to, 'rendererT')
  if (fromRendererT !== null && toRendererT !== null) {
    return toRendererT - fromRendererT
  }
  const inApp = delta(events, from, to)
  if (inApp !== null) {
    return inApp
  }
  const a = eventTime(events, from, 'harness')
  const b = eventTime(events, to, 'harness')
  return a !== null && b !== null ? b - a : null
}

/**
 * Fail fast on wait-event/state-profile combinations that can never fire:
 * with `--state-profile none` no session restores, no terminal pane presents,
 * and 'renderer-first-terminal-frame' would silently burn --timeout-ms per
 * iteration.
 */
export function assertWaitEventCanFire({ waitForEvent, stateProfile }) {
  if (waitForEvent === 'renderer-first-terminal-frame' && stateProfile === 'none') {
    throw new Error(
      '--wait-for-event renderer-first-terminal-frame never fires with --state-profile none ' +
        '(no terminals restore, so no pane presents a frame). ' +
        'Fix: add --state-profile restored-local-tabs --session-tabs <n> ' +
        '(or use `pnpm bench:first-terminal`).'
    )
  }
}
