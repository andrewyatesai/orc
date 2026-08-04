import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { TerminalCheckpointFile } from './types'
import { decodeTerminalHistoryLog, LOG_HEADER_BYTES } from './terminal-history-log'
import { HeadlessEmulator } from './headless-emulator'
import { createOsc633CommandlineScanner } from '../../shared/terminal-osc633-commandline'
import { PrioritySemaphore } from './priority-semaphore'
import { ColdRestoreReplayWriter } from './cold-restore-replay-writer'
import { readTerminalHistoryBufferAsync } from './terminal-history-file-reader'
import { TERMINAL_HISTORY_LOG_MAX_BYTES } from './terminal-history-file-limits'
import type { SessionMeta } from './terminal-history-metadata'
import {
  coldRestoreInfoFromSnapshot,
  type ColdRestoreInfo as RestoredColdRestoreInfo
} from './terminal-history-cold-restore-info'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'

export type ColdRestoreInfo = RestoredColdRestoreInfo & {
  /** Last OSC 633;E command line replayed from the raw log (#7596). Honest
   *  degradation: a command older than the log window yields no value. */
  lastCommand?: string
}

type IncrementalLogRestore = {
  restoreInfo: ColdRestoreInfo | null
  readFailed: boolean
}

// Why: parallel pane mounts should interleave with main-process work without multiplying replay slices per turn.
const coldRestoreReplaySemaphore = new PrioritySemaphore(1)

// Why a scratch emulator: replaying base + raw records through the same
// emulator the daemon used reproduces the exact terminal state at the last
// appended batch — including alt-screen and mode handling — and reuses
// getSnapshot()'s normalization instead of string-level reconstruction.
export async function restoreFromIncrementalLog(
  sessionDir: string,
  meta: SessionMeta,
  checkpoint: TerminalCheckpointFile | null,
  wslDistro?: string
): Promise<IncrementalLogRestore> {
  const logPath = join(sessionDir, 'output.log')
  try {
    // Why: final checkpoints leave a header-only log; they need no scarce replay slot and must not queue sleep teardown behind startup restores.
    if ((await stat(logPath)).size <= LOG_HEADER_BYTES) {
      return { restoreInfo: null, readFailed: false }
    }
  } catch {
    return { restoreInfo: null, readFailed: existsSync(logPath) }
  }
  const release = await coldRestoreReplaySemaphore.acquire(0)
  try {
    let logBuffer: Buffer
    try {
      logBuffer = await readTerminalHistoryBufferAsync(logPath, TERMINAL_HISTORY_LOG_MAX_BYTES)
    } catch {
      return { restoreInfo: null, readFailed: true }
    }
    const log = decodeTerminalHistoryLog(logBuffer)
    if (!log || log.batches.length === 0) {
      return { restoreInfo: null, readFailed: true }
    }
    // Generation mismatch means the log does not continue this checkpoint
    // (e.g. crash between checkpoint rename and log reset, or a pre-log
    // checkpoint without a generation field). Replaying it would duplicate or
    // garble content; the checkpoint alone is consistent.
    if (checkpoint) {
      if (typeof checkpoint.generation !== 'number' || log.generation !== checkpoint.generation) {
        return { restoreInfo: null, readFailed: false }
      }
    } else if (log.generation !== 0) {
      return { restoreInfo: null, readFailed: true }
    }

    const emulator = new HeadlessEmulator({
      cols: checkpoint?.cols ?? meta.cols,
      rows: checkpoint?.rows ?? meta.rows,
      wslDistro
    })
    const replay = new ColdRestoreReplayWriter(emulator)
    // #7596: the raw log is the only place the shell hooks' 633;E bytes
    // survive (serialized checkpoints drop OSC), so scan it during replay.
    const commandlineScanner = createOsc633CommandlineScanner()
    try {
      if (checkpoint) {
        // Only prefix scrollback on the alt screen: there snapshotAnsi is the
        // alt buffer and scrollbackAnsi carries the separate main-buffer
        // history. On a normal screen serialize_ansi ALREADY prepends the
        // history into snapshotAnsi, so adding scrollbackAnsi doubles the
        // whole scrollback on cold restore. Matches buildColdRestorePayload.
        const checkpointScrollbackAnsi = checkpoint.modes?.alternateScreen
          ? (checkpoint.scrollbackAnsi ?? '')
          : ''
        if (
          !(await replay.write(checkpointScrollbackAnsi)) ||
          !(await replay.write(checkpoint.rehydrateSequences)) ||
          !(await replay.write(checkpoint.snapshotAnsi)) ||
          !(await replay.write(checkpoint.pendingEscapeTailAnsi ?? ''))
        ) {
          return { restoreInfo: null, readFailed: true }
        }
        emulator.setRestoredOscLinks(checkpoint.oscLinks)
        if (checkpoint.lastTitle) {
          emulator.setLastTitle(checkpoint.lastTitle)
        }
      }
      for (const batch of log.batches) {
        for (const record of batch.records) {
          if (record.kind === 'output') {
            if (!(await replay.write(record.data))) {
              return { restoreInfo: null, readFailed: true }
            }
            commandlineScanner.scan(record.data)
          } else if (record.kind === 'resize') {
            if (!isValidTerminalHistorySize(record.cols, record.rows)) {
              return { restoreInfo: null, readFailed: true }
            }
            await replay.resize(record.cols, record.rows)
          } else {
            await replay.clearScrollback()
          }
        }
      }
      const snapshot = emulator.getSnapshot()
      const lastCommand = commandlineScanner.lastCommandline()
      return {
        restoreInfo: {
          ...coldRestoreInfoFromSnapshot(
            snapshot,
            snapshot.cwd ?? checkpoint?.cwd ?? meta.cwd,
            meta
          ),
          // Why: only the raw-log replay carries shell-hook bytes; checkpoint-only
          // and scrollback.bin restores never offer a re-run.
          ...(lastCommand !== null ? { lastCommand } : {})
        },
        readFailed: log.truncatedTail
      }
    } catch {
      // Why: a replay failure must degrade to checkpoint-only restore, never
      // surface as a failed spawn.
      return { restoreInfo: null, readFailed: true }
    } finally {
      emulator.dispose()
    }
  } finally {
    release()
  }
}
