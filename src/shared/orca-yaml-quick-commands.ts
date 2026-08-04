import { asRecord, asTrimmedString } from './orca-yaml-field-coercion'
import { MAX_ORCA_YAML_COLLECTION_ENTRIES } from './orca-yaml-file-limit'
import {
  MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
} from './terminal-quick-commands'
import type { OrcaProjectQuickCommand, OrcaVmRecipeDiagnostic } from './types'

// Why: shared yaml is repo-controlled input — a hard entry cap plus the settings
// text caps bound what a hostile orca.yaml can push at the trust dialog and menus.
export const ORCA_YAML_QUICK_COMMAND_CAP = 30

export type QuickCommandParseResult = {
  quickCommands: OrcaProjectQuickCommand[]
  diagnostics: OrcaVmRecipeDiagnostic[]
}

export function normalizeQuickCommands(value: unknown): QuickCommandParseResult {
  const diagnostics: OrcaVmRecipeDiagnostic[] = []
  if (!Array.isArray(value)) {
    return { quickCommands: [], diagnostics }
  }

  const quickCommands: OrcaProjectQuickCommand[] = []
  for (const [index, entry] of value.entries()) {
    if (quickCommands.length >= ORCA_YAML_QUICK_COMMAND_CAP) {
      diagnostics.push({
        index,
        message: `quickCommands is capped at ${ORCA_YAML_QUICK_COMMAND_CAP} entries; ${value.length - index} extra ignored.`
      })
      break
    }
    // Upstream's collection-entry cap re-expressed here: an all-invalid array
    // otherwise emits one diagnostic per entry, since the 30-command cap never trips.
    if (index >= MAX_ORCA_YAML_COLLECTION_ENTRIES) {
      diagnostics.push({
        index,
        message: `Only the first ${MAX_ORCA_YAML_COLLECTION_ENTRIES} quickCommands entries are read.`
      })
      break
    }
    const record = asRecord(entry)
    if (!record) {
      diagnostics.push({ index, message: 'Quick command entry must be a mapping.' })
      continue
    }
    const label = asTrimmedString(record.label)?.slice(0, MAX_QUICK_COMMAND_LABEL_LENGTH)
    if (!label) {
      diagnostics.push({ index, field: 'label', message: 'Quick command label is required.' })
      continue
    }
    const action = record.action
    if (action !== undefined && action !== 'agent-prompt' && action !== 'terminal-command') {
      diagnostics.push({
        index,
        field: 'action',
        message: `Quick command "${label}" has an unknown action. Use "agent-prompt" or omit action.`
      })
      continue
    }
    if (action === 'agent-prompt') {
      const agent = asTrimmedString(record.agent)
      const prompt = asTrimmedString(record.prompt)?.slice(0, MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH)
      if (!agent || !prompt) {
        diagnostics.push({
          index,
          field: agent ? 'prompt' : 'agent',
          message: `Quick command "${label}" needs both agent and prompt for agent-prompt.`
        })
        continue
      }
      quickCommands.push({ label, action: 'agent-prompt', agent, prompt })
      continue
    }
    const command = asTrimmedString(record.command)?.slice(
      0,
      MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
    )
    if (!command) {
      diagnostics.push({
        index,
        field: 'command',
        message: `Quick command "${label}" is missing command.`
      })
      continue
    }
    quickCommands.push({
      label,
      command,
      ...(record.appendEnter === false ? { appendEnter: false } : {})
    })
  }
  return { quickCommands, diagnostics }
}
