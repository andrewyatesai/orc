// The TUI-agent selection DATA. The logic that read it —
// collapseDefaultTuiAgentToBuiltin, pickTuiAgent, normalizeDisabledTuiAgents,
// isTuiAgentEnabled, filterEnabledTuiAgents — is now
// `orca_agents::tui_agent_selection`, reached from every surface through
// `tui-agent-selection-resolution.ts` on the shared dispatch seam.
//
// The catalog stays here because it is read as data, not only as a validity set:
// `orchestration-skill-coverage.ts` iterates it, and
// `mobile/src/tasks/mobile-agent-catalog.test.ts` parses the literal out of THIS
// FILE'S SOURCE TEXT to keep the mobile catalog in the same order.
import type { TuiAgent } from './types'

// Keep this order in sync with the desktop agent catalog. It defines the
// automatic fallback priority when the user has not chosen a default agent.
export const TUI_AGENT_AUTO_PICK_ORDER = [
  'claude',
  'claude-agent-teams',
  'openclaude',
  'codex',
  'grok',
  'copilot',
  'opencode',
  'mimo-code',
  'ante',
  'pi',
  'omp',
  'gemini',
  'antigravity',
  'aider',
  'goose',
  'amp',
  'kilo',
  'kiro',
  'crush',
  'aug',
  'autohand',
  'cline',
  'codebuff',
  'command-code',
  'continue',
  'cursor',
  'droid',
  'kimi',
  'mistral-vibe',
  'qwen-code',
  'rovo',
  'hermes',
  'devin',
  'openclaw'
] as const satisfies readonly TuiAgent[]

// Why: fresh installs should expose Claude Agent Teams in agent pickers; the
// persistence migration separately preserves the old hidden default for legacy profiles.
export const DEFAULT_DISABLED_TUI_AGENTS = [] as const satisfies readonly TuiAgent[]
