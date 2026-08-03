/**
 * `orca terminal ...` LIFECYCLE command specs — list/show/read plus create,
 * send, wait, close and friends. Split out of core.ts because the terminal
 * family is now the largest one there and kept pushing the file past its line
 * budget; grouping by command family keeps each spec module readable.
 *
 * The context-management verbs (history, search, blocks, images, screen,
 * agent-view, agent-transcript) live in `terminal-context.ts`, on the same seam
 * `handlers/terminal-context.ts` already uses.
 */
import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['terminal', 'list'],
    summary: 'List live Orca-managed terminals',
    usage: 'orca terminal list [--worktree <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'limit']
  },
  {
    path: ['terminal', 'show'],
    summary: 'Show terminal metadata and preview',
    usage: 'orca terminal show [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal']
  },
  {
    path: ['terminal', 'read'],
    summary: 'Read bounded terminal output',
    usage: 'orca terminal read [--terminal <handle>] [--cursor <n>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'cursor', 'limit'],
    notes: [
      'Omit --terminal to target the active terminal in the current worktree.',
      'Use --cursor with the nextCursor value from a previous read to get only new output since that read.',
      'Use --limit to request more retained lines for long agent responses; output reports oldestCursor when older lines were dropped.',
      'Useful for capturing the response to a command: read before sending, then read --cursor <prev> after waiting.'
    ],
    examples: [
      'orca terminal read --json',
      'orca terminal read --terminal term_abc123 --cursor 42 --limit 1000 --json'
    ]
  },
  {
    path: ['terminal', 'send'],
    summary: 'Send input to a live terminal',
    usage:
      'orca terminal send [--terminal <handle>] [--text <text>] [--enter] [--interrupt] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'text', 'enter', 'interrupt']
  },
  {
    path: ['terminal', 'wait'],
    summary: 'Wait for a terminal condition',
    usage:
      'orca terminal wait [--terminal <handle>] --for exit|tui-idle [--timeout-ms <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'for', 'timeout-ms']
  },
  {
    path: ['terminal', 'key'],
    summary: 'Press one key in a terminal, encoded against its live input modes',
    usage: 'orca terminal key [--terminal <handle>] --key <name|chord> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'key'],
    notes: [
      'Use this instead of terminal send for keys: what a key means on the wire depends on the pane’s modes, and the engine encodes it — with application-cursor on, Up is ESC O A and not ESC [ A, and a pane that negotiated the Kitty protocol gets a CSI-u report plus a key-up event.',
      '--key takes a chord: ctrl+r, shift+Tab, alt+f5, or a bare name. Names are DOM key values (Enter, Escape, ArrowUp, PageDown, F5), the aliases esc/ret/bs/del/ins/space/up/down/left/right/pgup/pgdn/home/end/f1-f35, or any single character.',
      'A key the engine cannot encode is refused BY NAME (unknown-key vs not-encodable) — it never sends an approximation, because a wrong escape sequence in a TUI is worse than no keystroke.',
      'It takes the pane exclusively while it writes, exactly as terminal submit does; a human typing into the pane preempts it and the result says so.',
      'sent:true means the terminal accepted the bytes, NOT that the program acted on them — nothing here watches the screen. Read terminal screen before and after to see what changed.',
      'This is how you expand an agent TUI’s own collapsed output: those lines were never written to the terminal, so no read verb can recover them from the pane — only the key the agent binds for expansion can.'
    ],
    examples: [
      'orca terminal key --key ctrl+r --json',
      'orca terminal key --terminal term_abc123 --key ArrowUp',
      'orca terminal key --key shift+Tab'
    ]
  },
  {
    path: ['terminal', 'submit'],
    summary: 'Submit a prompt to a TUI agent and verify it was submitted',
    usage:
      'orca terminal submit [--terminal <handle>] --prompt <text> [--settle-budget-ms <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'prompt', 'settle-budget-ms'],
    notes: [
      'Unlike terminal send, this reports evidence: submitted is yes, no, or unknown, with the tier it was decided on.',
      'Exit code 0 means submitted, 1 means definitively not submitted, 2 means unknown.',
      'unknown is terminal: the prompt may have landed, so never resend it — escalate to a human instead.',
      'Takes the pane exclusively while it writes; a human typing into the pane preempts it and the result says so.'
    ],
    examples: [
      'orca terminal submit --terminal term_abc123 --prompt "run the tests"',
      'orca terminal submit --prompt "status?" --json'
    ]
  },
  {
    path: ['terminal', 'stop'],
    summary: 'Stop terminals for a worktree or all local daemon sessions',
    usage: 'orca terminal stop --worktree <selector> [--json] | orca terminal stop --all [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'all'],
    notes: [
      '--all talks directly to the local terminal daemon, so it works after the Orca app/runtime has exited.'
    ]
  },
  {
    path: ['terminal', 'create'],
    summary: 'Create a terminal session in the current worktree',
    usage:
      'orca terminal create [--worktree <selector>] [--title <name>] [--command <text>] [--focus] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'command', 'title', 'focus'],
    notes: [
      'Creates a visible terminal tab without switching focus when possible; falls back to a background handle if the UI cannot adopt it. Pass --focus to switch to it.',
      'Use this, not worktree create, for a fresh agent in the current checkout.'
    ],
    examples: [
      'orca terminal create --json',
      'orca terminal create --worktree active --command "codex" --json',
      'orca terminal create --worktree path:/projects/myapp --title "RUNNER" --command "opencode"',
      'orca terminal create --worktree path:/projects/myapp --command "opencode" --focus'
    ]
  },
  {
    path: ['terminal', 'switch'],
    // Why: `focus` is the legacy verb for this action; keep it working as an
    // alias rather than a duplicate spec + handler registration.
    aliases: [['terminal', 'focus']],
    summary: 'Switch to a terminal tab in the UI',
    usage: 'orca terminal switch [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    examples: ['orca terminal switch --terminal term_abc123']
  },
  {
    path: ['terminal', 'close'],
    summary: 'Close a terminal pane/session, or its whole tab with --tab',
    usage: 'orca terminal close [--terminal <handle>] [--tab] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'tab'],
    notes: [
      'Without --tab, preserves the existing pane/session close behavior. With --tab, waits until the whole tab is durably removed.'
    ],
    examples: [
      'orca terminal close --terminal term_abc123',
      'orca terminal close --terminal term_abc123 --tab --json'
    ]
  },
  {
    path: ['terminal', 'rename'],
    summary: 'Set or clear the title of a terminal tab',
    usage: 'orca terminal rename [--terminal <handle>] [--title <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'title'],
    notes: ['Omit --title or pass an empty string to reset to the auto-generated title.'],
    examples: [
      'orca terminal rename --terminal term_abc123 --title "RUNNER"',
      'orca terminal rename --terminal term_abc123 --json'
    ]
  },
  {
    path: ['terminal', 'split'],
    summary: 'Split an existing terminal pane',
    usage:
      'orca terminal split [--terminal <handle>] [--direction horizontal|vertical] [--command <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'direction', 'command'],
    examples: [
      'orca terminal split --terminal term_abc123 --direction horizontal --json',
      'orca terminal split --terminal term_abc123 --command "codex"'
    ]
  }
]
