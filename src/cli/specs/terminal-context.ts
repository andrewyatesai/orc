/**
 * `orca terminal history | search | blocks | block-text | images | screen |
 * agent-view | agent-transcript` — the specs for the context-management face a
 * driving AI uses to orient in a pane it is not looking at.
 *
 * Split from specs/terminal.ts along the same seam handlers/terminal-context.ts
 * already uses: the lifecycle verbs (create, send, wait, close) are a different
 * family, and keeping them together kept pushing one file past its line budget.
 *
 * Every note here earns its place by naming a blind spot. These verbs exist so a
 * driver can tell "not there" from "I cannot see", and a summary that hides the
 * difference would undo the work the result shapes do.
 */
import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_CONTEXT_COMMAND_SPECS: CommandSpec[] = [
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
    path: ['terminal', 'images'],
    summary: 'List the inline images on a terminal’s visible screen',
    usage:
      'orca terminal images [--terminal <handle>] [--bytes] [--max-bytes <n>] [--max-total-bytes <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'bytes', 'max-bytes', 'max-total-bytes'],
    notes: [
      'Returns the original bytes the program emitted (an iTerm2 OSC-1337 PNG, or the engine-decoded RGBA8 raster of a sixel) — not a screenshot of the pane.',
      'Metadata only by default; pass --bytes for base64 payloads. An image over the per-image cap is withheld whole rather than truncated, and says so.',
      'Scope is the VISIBLE grid. The engine discards image payloads when a row scrolls off, so an empty result plus a non-zero unscannableHistoryRows means "not on screen now", not "this pane emitted none".',
      'A build with no image binding answers available:false with addon-too-old — never an empty list.'
    ],
    examples: [
      'orca terminal images --json',
      'orca terminal images --terminal term_abc123 --bytes --max-bytes 1048576 --json'
    ]
  },
  {
    path: ['terminal', 'screen'],
    summary: 'Read the styled visible grid: colour, attributes, cursor and input modes',
    usage:
      'orca terminal screen [--terminal <handle>] [--detail compact|full] [--from-row <n>] [--rows <n>] [--max-runs <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'detail', 'from-row', 'rows', 'max-runs'],
    notes: [
      'The only read that is not plain text: terminal read strips all SGR, so it cannot tell you which row is selected, highlighted or focused.',
      'Colours come back resolved (#rrggbb) exactly as rendered — inverse, dim, bold-to-bright and DECSCNM already applied — with the raw SGR bits alongside in attrs.',
      'Cells are coalesced into style runs; a run’s cols exceeds its text length wherever a wide CJK/emoji glyph sits.',
      'It reports the modes that change what your input MEANS: with application-cursor on, an arrow key is ESC O A and not ESC [ A.',
      'Scope is the LIVE grid. Scrolled-off rows keep their text and lose their colour, so there is no styled history — page that with terminal history.',
      'A build with no screen binding answers available:false with addon-too-old — never an empty grid.'
    ],
    examples: [
      'orca terminal screen --json',
      'orca terminal screen --terminal term_abc123 --detail full --json',
      'orca terminal screen --from-row 20 --rows 10'
    ]
  },
  {
    path: ['terminal', 'agent-view'],
    summary: 'One-shot orientation: screen, agent status, last block, history depth',
    usage: 'orca terminal agent-view [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    notes: [
      'One call instead of read + agentStatus + blocks + history, all from the same settled instant.',
      'The screen is the engine’s plain-text grid: no colour, no inline images. The result names those blind spots explicitly, so "cannot see" is distinguishable from "not there".',
      'Use terminal screen when you need the styling itself — which row is highlighted, where the cursor sits, which input modes are on.'
    ],
    examples: ['orca terminal agent-view --json', 'orca terminal agent-view --terminal term_abc123']
  },
  {
    path: ['terminal', 'agent-transcript'],
    summary: 'Read the agent’s own transcript for a pane, including collapsed tool output',
    usage:
      'orca terminal agent-transcript [--terminal <handle>] [--limit <turns>] [--before <offset>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'limit', 'before'],
    notes: [
      'When an agent TUI prints "… +N lines" those lines never reached the terminal, so no terminal read can recover them — this reads the agent’s own file, where they are untruncated.',
      'Turns are newest-last; --before takes the previousOffset a prior result returned, to page older.',
      'Readers exist for claude, openclaude, codex and grok. Any other agent, a pane with no reported session, or a pane whose agent runs on another host is refused BY NAME — never as an empty turn list.',
      'An SSH pane’s transcript is a file on the remote host: the refusal names the connection and the path there.',
      'It is not a screen. An in-flight turn or a pending permission prompt is not in it yet — use terminal agent-view for what the pane shows now.'
    ],
    examples: [
      'orca terminal agent-transcript --json',
      'orca terminal agent-transcript --terminal term_abc123 --limit 5 --json'
    ]
  }
]
