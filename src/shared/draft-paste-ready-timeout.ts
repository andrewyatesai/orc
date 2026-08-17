import type { TuiAgent } from './types'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

// Why: most agents render their composer within a couple of seconds, but a cold
// Codex start (trust preflight + composer mount) can take much longer; a flat 8s
// budget dropped those startup drafts. Agents opt into a longer deadline via
// `draftPasteReadyTimeoutMs`; everyone else keeps the flat 8s.
const DEFAULT_DRAFT_PASTE_READY_TIMEOUT_MS = 8000

export function resolveDraftPasteReadyTimeoutMs(agent?: TuiAgent, overrideMs?: number): number {
  return (
    overrideMs ??
    (agent ? TUI_AGENT_CONFIG[agent].draftPasteReadyTimeoutMs : undefined) ??
    DEFAULT_DRAFT_PASTE_READY_TIMEOUT_MS
  )
}
