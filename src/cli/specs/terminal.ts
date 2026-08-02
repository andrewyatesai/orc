/**
 * `orca terminal ...` command specs. Split out of core.ts because the terminal
 * family is now the largest one there and kept pushing the file past its line
 * budget; grouping by command family keeps each spec module readable.
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
    path: ['terminal', 'history'],
    summary: 'Read a window of a terminal’s engine scrollback',
    usage: 'orca terminal history [--terminal <handle>] [--from <row>] [--count <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'from', 'count'],
    notes: [
      'Reads the engine’s own scrollback, which is deeper than the transcript terminal read pages.',
      '--from takes a stable host row: feed it a row from terminal search, or the previousHostRow/nextHostRow this verb returns, to walk backward and forward without losing your place.',
      'Rows span history AND the visible screen, so omitting --from shows what is on screen right now.',
      'History rows are plain text: the engine drops colour and inline images when a row scrolls off.'
    ],
    examples: [
      'orca terminal history --json',
      'orca terminal history --terminal term_abc123 --from 4200 --count 400 --json'
    ]
  },
  {
    path: ['terminal', 'search'],
    summary: 'Search a terminal’s history and visible screen',
    usage:
      'orca terminal search [--terminal <handle>] --query <text> [--regex] [--case-sensitive] [--max-matches <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'query', 'regex', 'case-sensitive', 'max-matches'],
    notes: [
      'Scope is the pane’s retained history plus its visible grid, newest match first.',
      'An invalid regex yields zero matches rather than an error.',
      'Match rows are stable host rows: pass one to terminal history --from to read the surrounding output.'
    ],
    examples: [
      'orca terminal search --query "error" --json',
      'orca terminal search --terminal term_abc123 --query "^FAIL" --regex --max-matches 20'
    ]
  },
  {
    path: ['terminal', 'blocks'],
    summary: 'List the shell command blocks recorded for a terminal',
    usage: 'orca terminal blocks [--terminal <handle>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'limit'],
    notes: [
      'Blocks come from OSC 133, which Orca’s own shell hooks emit, so they cover instrumented shell panes.',
      'A pane running an agent CLI is ONE block for its whole session — use terminal agent-view or terminal read there instead.',
      'Block boundaries are transcript cursors: pass startCursor to terminal read --cursor to replay the same lines.'
    ],
    examples: ['orca terminal blocks --json', 'orca terminal blocks --limit 5']
  },
  {
    path: ['terminal', 'block-text'],
    summary: 'Read one command block’s output',
    usage:
      'orca terminal block-text [--terminal <handle>] [--block <index>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'block', 'limit'],
    notes: [
      'Omit --block for the newest block: "what did that last command print".',
      'outcome distinguishes text from evicted (the lines aged out of the transcript) and no-such-block; it is never a silently empty result.'
    ],
    examples: ['orca terminal block-text --json', 'orca terminal block-text --block 7 --json']
  },
  {
    path: ['terminal', 'agent-view'],
    summary: 'One-shot orientation: screen, agent status, last block, history depth',
    usage: 'orca terminal agent-view [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    notes: [
      'One call instead of read + agentStatus + blocks + history, all from the same settled instant.',
      'The screen is the engine’s plain-text grid: no colour, no inline images. The result names those blind spots explicitly, so "cannot see" is distinguishable from "not there".'
    ],
    examples: ['orca terminal agent-view --json', 'orca terminal agent-view --terminal term_abc123']
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
