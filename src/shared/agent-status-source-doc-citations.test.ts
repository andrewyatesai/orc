import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards the "self-contained references" invariant: docs/design/agent-status-over-ssh.md
// does not exist in the repo, so main/relay/shared agent-hook sources must carry the
// invariant inline instead of pointing readers at the absent doc. Renderer-side citations
// (useIpcEvents.ts, agent-status-types.ts) are intentionally excluded — a concurrent
// batching change owns those files and cleans them separately.
const REPO_ROOT = join(__dirname, '..', '..')
const DANGLING_DOC = 'agent-status-over-ssh'

const CLEANED_SOURCES = [
  'src/main/agent-hooks/installer-utils-remote.ts',
  'src/main/agent-hooks/server.ts',
  'src/main/cursor/hook-service.ts',
  'src/main/gemini/hook-service.ts',
  'src/main/ssh/ssh-relay-session.ts',
  'src/relay/agent-hook-server.ts',
  'src/relay/plugin-overlay.ts',
  'src/relay/pty-handler.ts',
  'src/relay/relay.ts',
  'src/shared/agent-hook-listener.ts',
  'src/shared/agent-hook-relay.ts'
]

describe('agent-status source doc citations', () => {
  it.each(CLEANED_SOURCES)('%s cites no absent design doc', (relPath) => {
    const body = readFileSync(join(REPO_ROOT, relPath), 'utf8')
    expect(body).not.toContain(DANGLING_DOC)
  })

  it('detector fires on a reintroduced citation (control)', () => {
    const planted = '// See docs/design/agent-status-over-ssh.md §8 (commit #8).'
    expect(planted).toContain(DANGLING_DOC)
  })
})
