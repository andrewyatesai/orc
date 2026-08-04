import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HISTORY_DIR_MODE, HISTORY_FILE_MODE } from './history-store-layout'
import type { SessionMeta } from './terminal-history-metadata'

/** Create a session's on-disk history directory and stamp its opening meta.json. */
export function createTerminalHistorySessionDirectory(
  dir: string,
  session: Pick<SessionMeta, 'cwd' | 'cols' | 'rows'>
): void {
  // Why modes: scrollback at rest routinely carries secrets, so dirs are 0o700 and files 0o600 from
  // creation (no-ops on Windows, where the store root's NTFS ACL covers the tree instead).
  mkdirSync(dir, { recursive: true, mode: HISTORY_DIR_MODE })

  const meta: SessionMeta = {
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), { mode: HISTORY_FILE_MODE })
}

/** Why: a crash before the first checkpoint must not replay a cleanly ended prior session. */
export function discardTerminalHistorySessionArtifacts(dir: string): void {
  for (const staleFile of [
    join(dir, 'checkpoint.json'),
    join(dir, 'scrollback.bin'),
    join(dir, 'output.log')
  ]) {
    try {
      unlinkSync(staleFile)
    } catch {
      // ENOENT is expected for new sessions
    }
  }
}
