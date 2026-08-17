import { isOpenCodeNativeTitle, isQuarterCircleSpinnerOnlyAgentTitle } from '../../shared/agent-detection'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TuiAgent } from '../../shared/types'

type AgentTitleClassification = 'agent' | 'management' | 'neutral'

// Why: only the managed-launch identity fields decide whether a quarter-circle
// title carries verified Claude ownership; keep the input narrow so this stays
// decoupled from the full PTY record.
export type ManagedLaunchIdentity = {
  launchAgent: TuiAgent | null
  launchToken: string | null
  launchIncarnationId: PtyIncarnationId | null
  incarnationId: PtyIncarnationId | null
}

// Why: an 'agent' title only proves an agent owns the pane when something other than a
// quarter-circle spinner carries it — those glyphs are generic progress frames (STA-4028).
export function agentTitleProvesAgentPresence(
  title: string | null,
  classification: AgentTitleClassification
): boolean {
  return (
    classification === 'agent' &&
    !isOpenCodeNativeTitle(title) &&
    !isQuarterCircleSpinnerOnlyAgentTitle(title)
  )
}

// Why: a lone quarter-circle title still authorizes on the exact PTY incarnation that
// received a verified managed-Claude launch token — identity the process itself proves.
export function ptyTitleProvesAgentPresence(
  pty: ManagedLaunchIdentity,
  title: string | null,
  classification: AgentTitleClassification
): boolean {
  return (
    agentTitleProvesAgentPresence(title, classification) ||
    (isQuarterCircleSpinnerOnlyAgentTitle(title) &&
      pty.launchAgent === 'claude' &&
      pty.launchToken !== null &&
      pty.launchIncarnationId === pty.incarnationId)
  )
}
