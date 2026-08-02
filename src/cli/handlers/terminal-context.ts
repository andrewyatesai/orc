/**
 * `orca terminal history | blocks | block-text | images | agent-view |
 * agent-transcript | search` — the context-management face a driving AI uses to
 * orient in a pane it is not looking at. Split from handlers/terminal.ts so the
 * lifecycle verbs (create, send, wait, close) stay one readable group.
 *
 * The three cursor spaces these verbs speak are deliberately the ones the
 * existing verbs already speak: `--from` takes the stable host rows
 * `terminal search` returns, and block cursors are the transcript positions
 * `terminal read --cursor` pages.
 */
import type { CommandHandler } from '../dispatch'
import type {
  TerminalAgentView,
  TerminalCommandBlockText,
  TerminalCommandBlocksResult,
  TerminalHistoryWindow
} from '../../shared/terminal-context-protocol'
import type { TerminalAgentTranscript } from '../../shared/agent-transcript-protocol'
import type { TerminalInlineImagesResult } from '../../shared/terminal-inline-images-protocol'
import type { RemoteTerminalSearchResult } from '../../shared/terminal-remote-search-protocol'
import { formatTerminalImages } from '../terminal-images-format'
import {
  formatTerminalAgentTranscript,
  formatTerminalAgentView,
  formatTerminalBlockText,
  formatTerminalBlocks,
  formatTerminalHistory,
  formatTerminalSearch
} from '../terminal-context-format'
import { printResult } from '../format'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getRequiredStringFlag
} from '../flags'
import { getTerminalHandle } from '../selectors'

export const TERMINAL_CONTEXT_HANDLERS: Record<string, CommandHandler> = {
  'terminal history': async ({ flags, client, cwd, json }) => {
    const from = getOptionalNonNegativeIntegerFlag(flags, 'from')
    const result = await client.call<{ history: TerminalHistoryWindow }>('terminal.history', {
      terminal: await getTerminalHandle(flags, cwd, client),
      ...(from !== undefined ? { from } : {}),
      count: getOptionalPositiveIntegerFlag(flags, 'count')
    })
    printResult(result, json, (value) => formatTerminalHistory(value.history))
  },
  'terminal blocks': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ blocks: TerminalCommandBlocksResult }>('terminal.blocks', {
      terminal: await getTerminalHandle(flags, cwd, client),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, (value) => formatTerminalBlocks(value.blocks))
  },
  'terminal block-text': async ({ flags, client, cwd, json }) => {
    const index = getOptionalNonNegativeIntegerFlag(flags, 'block')
    const result = await client.call<{ blockText: TerminalCommandBlockText }>(
      'terminal.blockText',
      {
        terminal: await getTerminalHandle(flags, cwd, client),
        ...(index !== undefined ? { index } : {}),
        limit: getOptionalPositiveIntegerFlag(flags, 'limit')
      }
    )
    printResult(result, json, (value) => formatTerminalBlockText(value.blockText))
  },
  'terminal images': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ images: TerminalInlineImagesResult }>('terminal.images', {
      terminal: await getTerminalHandle(flags, cwd, client),
      includeBytes: flags.get('bytes') === true,
      maxBytesPerImage: getOptionalPositiveIntegerFlag(flags, 'max-bytes'),
      maxTotalBytes: getOptionalPositiveIntegerFlag(flags, 'max-total-bytes')
    })
    printResult(result, json, (value) => formatTerminalImages(value.images))
  },
  'terminal agent-view': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ agentView: TerminalAgentView }>('terminal.agentView', {
      terminal: await getTerminalHandle(flags, cwd, client)
    })
    printResult(result, json, (value) => formatTerminalAgentView(value.agentView))
  },
  'terminal agent-transcript': async ({ flags, client, cwd, json }) => {
    const before = getOptionalNonNegativeIntegerFlag(flags, 'before')
    const result = await client.call<{ agentTranscript: TerminalAgentTranscript }>(
      'terminal.agentTranscript',
      {
        terminal: await getTerminalHandle(flags, cwd, client),
        limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
        ...(before !== undefined ? { before } : {})
      }
    )
    printResult(result, json, (value) => formatTerminalAgentTranscript(value.agentTranscript))
  },
  'terminal search': async ({ flags, client, cwd, json }) => {
    const result = await client.call<RemoteTerminalSearchResult>('terminal.search', {
      terminal: await getTerminalHandle(flags, cwd, client),
      query: getRequiredStringFlag(flags, 'query'),
      caseSensitive: flags.get('case-sensitive') === true,
      regex: flags.get('regex') === true,
      maxMatches: getOptionalPositiveIntegerFlag(flags, 'max-matches')
    })
    printResult(result, json, formatTerminalSearch)
  }
}
