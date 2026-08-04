import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  promises as fsPromises
} from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicAsync } from '../atomic-file-write'
import { HISTORY_FILE_MODE } from './history-store-layout'
import {
  decodeLogHeader,
  encodeLogBatch,
  encodeLogHeader,
  LOG_HEADER_BYTES
} from './terminal-history-log'
import type { SessionMeta } from './terminal-history-metadata'
import { clearTerminalHistoryRecoveryProtection } from './terminal-history-recovery-quarantine'
import type { PendingOutputRecord, TerminalSnapshot } from './types'
import { TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES } from './terminal-history-file-limits'
import { serializeTerminalCheckpointWithinLimit } from './terminal-checkpoint-serializer'

// Why 5MB: bounds cold-restore replay time and per-session disk; hitting the cap triggers one checkpoint that resets the log.
const LOG_MAX_BYTES = 5 * 1024 * 1024

export class TerminalHistorySessionWriter {
  readonly checkpointPath: string
  readonly logPath: string
  private logGeneration: number | null
  private logBytes: number | null

  constructor(
    readonly dir: string,
    fresh: boolean,
    private readonly checkpointMaxBytes = TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES
  ) {
    this.checkpointPath = join(dir, 'checkpoint.json')
    this.logPath = join(dir, 'output.log')
    this.logGeneration = fresh ? 0 : null
    this.logBytes = fresh ? 0 : null
  }

  async appendIncrements(
    seq: number,
    records: PendingOutputRecord[]
  ): Promise<'ok' | 'needs-checkpoint'> {
    this.resolveLogState()
    const batch = encodeLogBatch(seq, records)
    const projectedBytes = Math.max(this.logBytes ?? 0, LOG_HEADER_BYTES) + batch.length
    if (projectedBytes > LOG_MAX_BYTES) {
      return 'needs-checkpoint'
    }
    if (this.logBytes === 0) {
      // Why mode: scrollback at rest carries secrets, so the log is 0o600 from creation.
      await fsPromises.writeFile(this.logPath, encodeLogHeader(this.logGeneration ?? 0), {
        mode: HISTORY_FILE_MODE
      })
      this.logBytes = LOG_HEADER_BYTES
    }
    await fsPromises.appendFile(this.logPath, batch, { mode: HISTORY_FILE_MODE })
    this.logBytes = (this.logBytes ?? LOG_HEADER_BYTES) + batch.length
    return 'ok'
  }

  async checkpoint(
    snapshot: TerminalSnapshot
  ): Promise<{ result: 'committed' } | { result: 'retryable'; error: Error }> {
    // Why: snapshot.cwd is null until OSC-7; preserve meta.json's usable cwd for cold restore.
    const effectiveCwd = snapshot.cwd ?? this.readMeta()?.cwd ?? null
    this.resolveLogState()
    const generation = (this.logGeneration ?? 0) + 1
    let data: string
    try {
      data = await serializeTerminalCheckpointWithinLimit(
        snapshot,
        {
          cwd: effectiveCwd,
          generation,
          checkpointedAt: new Date().toISOString()
        },
        this.checkpointMaxBytes
      )
    } catch (error) {
      return {
        result: 'retryable',
        error: error instanceof Error ? error : new Error(String(error))
      }
    }
    // Why: tmp+fsync+rename is atomic and power-loss-durable (a bare rename is not); the adapter's
    // checkpointInFlight guard serializes checkpoints so the fixed .tmp path can't collide.
    await writeFileAtomicAsync(this.checkpointPath, data, {
      mode: HISTORY_FILE_MODE,
      tmpPath: `${this.checkpointPath}.tmp`
    })
    await fsPromises.writeFile(this.logPath, encodeLogHeader(generation), {
      mode: HISTORY_FILE_MODE
    })
    this.logGeneration = generation
    this.logBytes = LOG_HEADER_BYTES
    clearTerminalHistoryRecoveryProtection(this.dir)
    return { result: 'committed' }
  }

  // Why: a warm writer must append to the existing generation without clobbering its log.
  private resolveLogState(): void {
    if (this.logBytes !== null && this.logGeneration !== null) {
      return
    }
    let headerGeneration: number | null = null
    let size = 0
    try {
      const fd = openSync(this.logPath, 'r')
      try {
        size = fstatSync(fd).size
        const header = Buffer.alloc(LOG_HEADER_BYTES)
        if (readSync(fd, header, 0, LOG_HEADER_BYTES, 0) === LOG_HEADER_BYTES) {
          headerGeneration = decodeLogHeader(header)
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      // Missing log file — fresh state below.
    }
    if (headerGeneration !== null) {
      this.logGeneration = headerGeneration
      this.logBytes = size
      return
    }
    this.logBytes = 0
    this.logGeneration = this.readCheckpointGeneration() ?? 0
  }

  private readCheckpointGeneration(): number | null {
    try {
      const checkpoint = JSON.parse(readFileSync(this.checkpointPath, 'utf-8'))
      return typeof checkpoint.generation === 'number' ? checkpoint.generation : null
    } catch {
      return null
    }
  }

  private readMeta(): SessionMeta | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'meta.json'), 'utf-8'))
    } catch {
      return null
    }
  }
}
