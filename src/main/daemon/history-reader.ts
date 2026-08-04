import { join } from 'node:path'
import { existsSync, opendirSync } from 'node:fs'
import { getHistorySessionDirName } from './history-paths'
import { detectColdRestoreFromLegacyScrollback } from './terminal-history-legacy-scrollback-restore'
import {
  retainNewestRestorableTerminalHistorySessions,
  type RestorableTerminalHistorySession
} from './terminal-history-restorable-retention'
import {
  hasTerminalHistoryRecoveryProtection,
  isTerminalHistoryQuarantineEntry
} from './terminal-history-recovery-quarantine'
import { isTerminalHistoryPendingDeleteEntry } from './terminal-history-session-tombstone'
import {
  readTerminalHistoryMeta,
  type SessionMeta,
  type SessionMetaRead
} from './terminal-history-metadata'
import { coldRestoreInfoFromSnapshot } from './terminal-history-cold-restore-info'
import { readTerminalHistoryCheckpoint } from './terminal-history-checkpoint-reader'
import {
  restoreFromIncrementalLog,
  type ColdRestoreInfo
} from './terminal-history-incremental-log-restore'

// Why: ColdRestoreInfo is re-exported here because callers have always imported it from the reader.
export type { ColdRestoreInfo }

export type RestorableHistoryProbe =
  | { status: 'none' }
  | { status: 'restorable'; sessionId: string }
  | { status: 'unreadable'; sessionId: string }

export type ColdRestoreDetection =
  | { status: 'none' }
  | {
      status: 'restored'
      sessionId: string
      restoreInfo: ColdRestoreInfo
      hasUnreadableRecovery: boolean
    }
  | { status: 'unreadable'; sessionId: string }

export class HistoryReader {
  private basePath: string

  constructor(basePath: string) {
    this.basePath = basePath
  }

  // Why: spawn needs a cheap "could this cold-restore?" predicate before
  // deciding to pay detectColdRestore's full checkpoint+log replay. Reads only
  // the small meta.json, using the same unclean-shutdown test detectColdRestore
  // starts with.
  probeRestorableHistory(sessionId: string): RestorableHistoryProbe {
    if (hasTerminalHistoryRecoveryProtection(this.basePath, sessionId)) {
      return { status: 'unreadable', sessionId }
    }
    const metaRead = this.readMetaState(sessionId)
    if (metaRead.status === 'unreadable') {
      return { status: 'unreadable', sessionId }
    }
    if (metaRead.status === 'missing' || metaRead.meta.endedAt !== null) {
      return { status: 'none' }
    }
    return { status: 'restorable', sessionId }
  }

  hasRestorableHistory(sessionId: string): boolean {
    return this.probeRestorableHistory(sessionId).status !== 'none'
  }

  async detectColdRestore(
    sessionId: string,
    opts?: { ignoreCleanEnd?: boolean; wslDistro?: string }
  ): Promise<ColdRestoreInfo | null> {
    const detection = await this.detectColdRestoreState(sessionId, opts)
    return detection.status === 'restored' ? detection.restoreInfo : null
  }

  async detectColdRestoreState(
    sessionId: string,
    opts?: { ignoreCleanEnd?: boolean; wslDistro?: string }
  ): Promise<ColdRestoreDetection> {
    if (hasTerminalHistoryRecoveryProtection(this.basePath, sessionId)) {
      return { status: 'unreadable', sessionId }
    }
    const metaRead = this.readMetaState(sessionId)
    if (metaRead.status === 'missing') {
      return { status: 'none' }
    }
    if (metaRead.status === 'unreadable') {
      return { status: 'unreadable', sessionId }
    }
    const meta = metaRead.meta
    // Why ignoreCleanEnd: in the spawn probe race, the dying session's exit
    // event can write endedAt between the aliveness probe and the post-spawn
    // fallback detect. The caller established restore eligibility before the
    // probe, so the just-written clean end must not downgrade the restore.
    if (meta.endedAt !== null && !opts?.ignoreCleanEnd) {
      return { status: 'none' }
    }

    const sessionDir = join(this.basePath, getHistorySessionDirName(sessionId))
    const checkpointPath = join(sessionDir, 'checkpoint.json')
    const checkpointRead = await readTerminalHistoryCheckpoint(checkpointPath)
    const checkpoint = checkpointRead.status === 'readable' ? checkpointRead.checkpoint : null
    const checkpointReadFailed = checkpointRead.status === 'unreadable'

    // Why log replay is preferred over the checkpoint alone: the log carries
    // byte-exact output up to ~5s before the crash (up to the full-snapshot
    // cooldown, ~45s, for a streaming session mid-deferral), while the
    // checkpoint can be a full log-cap (~5MB of output) stale.
    const logRestore = await restoreFromIncrementalLog(
      sessionDir,
      meta,
      checkpoint,
      opts?.wslDistro
    )
    if (logRestore.restoreInfo) {
      return {
        status: 'restored',
        sessionId,
        restoreInfo: logRestore.restoreInfo,
        hasUnreadableRecovery: checkpointReadFailed || logRestore.readFailed
      }
    }

    if (!checkpoint) {
      // Why: backward compatibility with pre-checkpoint sessions, and corrupt
      // checkpoints — the old scrollback.bin is the best remaining data.
      const legacyPath = join(sessionDir, 'scrollback.bin')
      const legacyExists = existsSync(legacyPath)
      const legacyRestore = await detectColdRestoreFromLegacyScrollback(
        this.basePath,
        sessionId,
        meta
      )
      if (legacyRestore) {
        return {
          status: 'restored',
          sessionId,
          restoreInfo: legacyRestore,
          hasUnreadableRecovery: checkpointReadFailed || logRestore.readFailed
        }
      }
      return checkpointReadFailed || logRestore.readFailed || legacyExists
        ? { status: 'unreadable', sessionId }
        : { status: 'none' }
    }

    return {
      status: 'restored',
      sessionId,
      restoreInfo: coldRestoreInfoFromSnapshot(checkpoint, checkpoint.cwd, meta),
      hasUnreadableRecovery: logRestore.readFailed
    }
  }

  listRestorable(): string[] {
    if (!existsSync(this.basePath)) {
      return []
    }

    let directory: ReturnType<typeof opendirSync>
    try {
      directory = opendirSync(this.basePath)
    } catch {
      return []
    }

    const sessions = function* (
      reader: HistoryReader
    ): Generator<RestorableTerminalHistorySession> {
      let order = 0
      while (true) {
        const entry = directory.readSync()
        if (!entry) {
          return
        }
        if (!entry.isDirectory()) {
          continue
        }
        if (
          isTerminalHistoryQuarantineEntry(entry.name) ||
          isTerminalHistoryPendingDeleteEntry(entry.name)
        ) {
          continue
        }
        let sessionId: string
        try {
          sessionId = decodeURIComponent(entry.name)
        } catch {
          continue
        }
        const meta = reader.readMeta(sessionId)
        if (meta && meta.endedAt === null) {
          const parsedStartedAt = Date.parse(meta.startedAt)
          yield {
            sessionId,
            startedAtMs: Number.isFinite(parsedStartedAt) ? parsedStartedAt : 0,
            order
          }
          order += 1
        }
      }
    }

    try {
      return retainNewestRestorableTerminalHistorySessions(sessions(this))
    } catch {
      return []
    } finally {
      try {
        directory.closeSync()
      } catch {
        // Best effort after a directory read failure.
      }
    }
  }

  private readMeta(sessionId: string): SessionMeta | null {
    const metaRead = this.readMetaState(sessionId)
    return metaRead.status === 'readable' ? metaRead.meta : null
  }

  private readMetaState(sessionId: string): SessionMetaRead {
    return readTerminalHistoryMeta(this.basePath, sessionId)
  }
}
