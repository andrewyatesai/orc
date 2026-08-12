import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateAiVaultSessionDeleteTarget } from './session-delete-target'

const PI_ROOT = resolve('/tmp/orca-delete-test/pi')
const CLAUDE_ROOT = resolve('/tmp/orca-delete-test/.claude/projects')
const GROK_ROOT = resolve('/tmp/orca-delete-test/grok')
const CURSOR_ROOT = resolve('/tmp/orca-delete-test/.cursor/projects')

describe('validateAiVaultSessionDeleteTarget', () => {
  it('accepts a single-file session inside the agent root and plans a file removal', () => {
    const filePath = join(PI_ROOT, 'session-abc.jsonl')
    const result = validateAiVaultSessionDeleteTarget({
      agent: 'pi',
      filePath,
      executionHostId: 'local',
      rootOptions: { piSessionsDir: PI_ROOT }
    })
    expect(result).toMatchObject({
      allowed: true,
      agent: 'pi',
      resolvedPath: filePath,
      removals: [{ path: filePath, kind: 'file' }]
    })
  })

  it('rejects an unsupported (registry-backed) agent', () => {
    const result = validateAiVaultSessionDeleteTarget({
      agent: 'codex',
      filePath: '/anywhere/session.jsonl',
      executionHostId: 'local'
    })
    expect(result).toEqual({ allowed: false, agent: 'codex', reason: 'unsupported-agent' })
  })

  it('rejects a non-local (SSH/runtime) session', () => {
    const result = validateAiVaultSessionDeleteTarget({
      agent: 'pi',
      filePath: join(PI_ROOT, 'x.jsonl'),
      executionHostId: 'ssh:host',
      rootOptions: { piSessionsDir: PI_ROOT }
    })
    expect(result).toEqual({ allowed: false, agent: 'pi', reason: 'non-local-host' })
  })

  it('rejects a synthetic OpenCode-SQLite identity path', () => {
    const result = validateAiVaultSessionDeleteTarget({
      agent: 'pi',
      filePath: `${join(PI_ROOT, 'db.sqlite')}#session-1`,
      executionHostId: 'local',
      rootOptions: { piSessionsDir: PI_ROOT }
    })
    expect(result).toEqual({ allowed: false, agent: 'pi', reason: 'synthetic-path' })
  })

  it('rejects a path that escapes the agent root via ..', () => {
    const result = validateAiVaultSessionDeleteTarget({
      agent: 'pi',
      filePath: join(PI_ROOT, '..', '..', 'etc', 'passwd.jsonl'),
      executionHostId: 'local',
      rootOptions: { piSessionsDir: PI_ROOT }
    })
    expect(result).toEqual({ allowed: false, agent: 'pi', reason: 'path-outside-known-roots' })
  })

  it('rejects a path the scanner would never surface (wrong extension)', () => {
    const result = validateAiVaultSessionDeleteTarget({
      agent: 'pi',
      filePath: join(PI_ROOT, 'notes.txt'),
      executionHostId: 'local',
      rootOptions: { piSessionsDir: PI_ROOT }
    })
    expect(result).toEqual({ allowed: false, agent: 'pi', reason: 'undiscoverable-path' })
  })

  it("mirrors the scanner's file predicate: cursor requires an agent-transcripts segment", () => {
    const outside = validateAiVaultSessionDeleteTarget({
      agent: 'cursor',
      filePath: join(CURSOR_ROOT, 'proj', 'chat.jsonl'),
      executionHostId: 'local',
      rootOptions: { cursorProjectsDir: CURSOR_ROOT }
    })
    expect(outside).toEqual({ allowed: false, agent: 'cursor', reason: 'undiscoverable-path' })

    const inside = validateAiVaultSessionDeleteTarget({
      agent: 'cursor',
      filePath: join(CURSOR_ROOT, 'proj', 'agent-transcripts', 'chat.jsonl'),
      executionHostId: 'local',
      rootOptions: { cursorProjectsDir: CURSOR_ROOT }
    })
    expect(inside).toMatchObject({ allowed: true, agent: 'cursor' })
  })

  it('rejects a Claude transcript inside a pruned subagents subtree', () => {
    const result = validateAiVaultSessionDeleteTarget({
      agent: 'claude',
      filePath: join(CLAUDE_ROOT, 'enc', 'uuid', 'subagents', 'agent-1.jsonl'),
      executionHostId: 'local',
      rootOptions: { claudeProjectsDir: CLAUDE_ROOT }
    })
    expect(result).toEqual({ allowed: false, agent: 'claude', reason: 'undiscoverable-path' })
  })

  it('plans companions-first for Claude: session dir, session-env, then the transcript', () => {
    const filePath = join(CLAUDE_ROOT, 'enc', 'uuid.jsonl')
    const result = validateAiVaultSessionDeleteTarget({
      agent: 'claude',
      filePath,
      executionHostId: 'local',
      rootOptions: { claudeProjectsDir: CLAUDE_ROOT }
    })
    expect(result).toMatchObject({
      allowed: true,
      agent: 'claude',
      removals: [
        { path: join(CLAUDE_ROOT, 'enc', 'uuid'), kind: 'directory' },
        { path: join(resolve('/tmp/orca-delete-test/.claude'), 'session-env', 'uuid'), kind: 'directory' },
        { path: filePath, kind: 'file' }
      ]
    })
  })

  it('removes the whole session directory for a directory-shaped agent (grok)', () => {
    const result = validateAiVaultSessionDeleteTarget({
      agent: 'grok',
      filePath: join(GROK_ROOT, 'sess-1', 'summary.json'),
      executionHostId: 'local',
      rootOptions: { grokSessionsDir: GROK_ROOT }
    })
    expect(result).toMatchObject({
      allowed: true,
      agent: 'grok',
      removals: [{ path: join(GROK_ROOT, 'sess-1'), kind: 'directory' }]
    })
  })

  it('refuses a directory-shaped file sitting directly in the root (no session dir)', () => {
    const result = validateAiVaultSessionDeleteTarget({
      agent: 'grok',
      filePath: join(GROK_ROOT, 'summary.json'),
      executionHostId: 'local',
      rootOptions: { grokSessionsDir: GROK_ROOT }
    })
    expect(result).toEqual({ allowed: false, agent: 'grok', reason: 'no-session-directory' })
  })

  it('rejects a blank path', () => {
    const result = validateAiVaultSessionDeleteTarget({
      agent: 'pi',
      filePath: '   ',
      executionHostId: 'local'
    })
    expect(result).toEqual({ allowed: false, agent: 'pi', reason: 'invalid-path' })
  })
})
