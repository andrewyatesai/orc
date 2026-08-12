import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AiVaultDeletableAgent } from '../../shared/ai-vault-session-deletion'
import { claudeProjectsRootDirs } from './session-scanner-source-discovery'
import { normalizeAgentSessionsDir } from './session-scanner-values'
import { resolveGrokSessionsDir } from '../../shared/grok-session-paths'
import type { AiVaultScanOptions } from './session-scanner-types'

// The fork keeps each agent's roots + accept rule inline in the scanner
// (session-scanner-source-discovery + droid-kimi-sources), not in a shared
// AI_VAULT_AGENT_SOURCES map. The delete validator needs the same two facts per
// deletable agent, so mirror them here, keyed to the same AiVaultScanOptions
// overrides the scanner honours (tests inject roots instead of touching $HOME).
// session-delete-target.test.ts pins this mirror against a scanner-discovered
// path so the two can't silently drift.
export type DeleteAgentSource = {
  rootDirs: (options: AiVaultScanOptions, wslHomeDirs: readonly string[]) => string[]
  // The scanner's own file-accept rule for this agent: a path it would never
  // have surfaced as a session row must not validate as a delete target either.
  extensions: readonly string[]
  filePredicate?: (resolvedPath: string) => boolean
}

function withWslHomes(
  hostRootDir: string,
  wslHomeDirs: readonly string[],
  segments: readonly string[]
): string[] {
  return [hostRootDir, ...wslHomeDirs.map((homeDir) => join(homeDir, ...segments))]
}

function pathSegments(resolvedPath: string): string[] {
  return resolvedPath.split(/[\\/]/)
}

export const AI_VAULT_DELETE_SOURCES: Record<AiVaultDeletableAgent, DeleteAgentSource> = {
  gemini: {
    rootDirs: (options, wsl) =>
      withWslHomes(options.geminiSessionsDir ?? join(homedir(), '.gemini', 'tmp'), wsl, [
        '.gemini',
        'tmp'
      ]),
    extensions: ['.json', '.jsonl']
  },
  copilot: {
    rootDirs: (options, wsl) =>
      withWslHomes(
        options.copilotSessionsDir ??
          join(process.env.COPILOT_HOME?.trim() || join(homedir(), '.copilot'), 'session-state'),
        wsl,
        ['.copilot', 'session-state']
      ),
    extensions: ['.jsonl']
  },
  cursor: {
    rootDirs: (options, wsl) =>
      withWslHomes(options.cursorProjectsDir ?? join(homedir(), '.cursor', 'projects'), wsl, [
        '.cursor',
        'projects'
      ]),
    extensions: ['.jsonl'],
    filePredicate: (path) => pathSegments(path).includes('agent-transcripts')
  },
  hermes: {
    rootDirs: (options, wsl) =>
      withWslHomes(options.hermesSessionsDir ?? join(homedir(), '.hermes', 'sessions'), wsl, [
        '.hermes',
        'sessions'
      ]),
    extensions: ['.json'],
    filePredicate: (path) => basename(path).startsWith('session_')
  },
  devin: {
    rootDirs: (options, wsl) =>
      withWslHomes(
        options.devinTranscriptsDir ??
          join(
            process.env.DEVIN_HOME?.trim() || join(homedir(), '.local', 'share', 'devin', 'cli'),
            'transcripts'
          ),
        wsl,
        ['.local', 'share', 'devin', 'cli', 'transcripts']
      ),
    extensions: ['.json']
  },
  openclaw: {
    // Discovery walks `<stateDir>/agents`, so the delete roots are those `agents`
    // dirs (not the state dir itself) and the transcript must sit under a
    // `sessions` segment — the same predicate discoverOpenClawFiles applies.
    rootDirs: (options, wsl) =>
      [
        options.openclawStateDir ??
          (process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), '.openclaw')),
        options.openclawLegacyStateDir ?? join(homedir(), '.clawdbot'),
        ...wsl.map((homeDir) => join(homeDir, '.openclaw')),
        ...wsl.map((homeDir) => join(homeDir, '.clawdbot'))
      ].map((rootDir) => (basename(rootDir) === 'agents' ? rootDir : join(rootDir, 'agents'))),
    extensions: ['.jsonl'],
    filePredicate: (path) => pathSegments(path).includes('sessions')
  },
  droid: {
    rootDirs: (options, wsl) => [
      ...withWslHomes(options.droidSessionsDir ?? join(homedir(), '.factory', 'sessions'), wsl, [
        '.factory',
        'sessions'
      ]),
      ...withWslHomes(options.droidProjectsDir ?? join(homedir(), '.factory', 'projects'), wsl, [
        '.factory',
        'projects'
      ])
    ],
    extensions: ['.jsonl']
  },
  pi: {
    rootDirs: (options, wsl) =>
      withWslHomes(
        options.piSessionsDir ??
          normalizeAgentSessionsDir(
            process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent', 'sessions'),
            '.pi'
          ),
        wsl,
        ['.pi', 'agent', 'sessions']
      ),
    extensions: ['.jsonl']
  },
  omp: {
    rootDirs: (options, wsl) =>
      withWslHomes(
        options.ompSessionsDir ??
          normalizeAgentSessionsDir(
            process.env.OMP_CODING_AGENT_DIR?.trim() || join(homedir(), '.omp', 'agent', 'sessions'),
            '.omp'
          ),
        wsl,
        ['.omp', 'agent', 'sessions']
      ),
    extensions: ['.jsonl']
  },
  claude: {
    rootDirs: (options, wsl) =>
      claudeProjectsRootDirs({ claudeProjectsDir: options.claudeProjectsDir, wslHomeDirs: wsl }),
    extensions: ['.jsonl'],
    // Discovery prunes the whole `subagents/` subtree, so a path inside one was
    // never a resumable session row.
    filePredicate: (path) => !pathSegments(path).includes('subagents')
  },
  rovo: {
    rootDirs: (options, wsl) =>
      withWslHomes(options.rovoSessionsDir ?? join(homedir(), '.rovodev', 'sessions'), wsl, [
        '.rovodev',
        'sessions'
      ]),
    extensions: ['.json'],
    filePredicate: (path) => basename(path) === 'metadata.json'
  },
  grok: {
    rootDirs: (options, wsl) =>
      withWslHomes(options.grokSessionsDir ?? resolveGrokSessionsDir(), wsl, ['.grok', 'sessions']),
    extensions: ['.json'],
    filePredicate: (path) => basename(path) === 'summary.json'
  }
}
