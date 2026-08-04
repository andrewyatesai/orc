// Query-authority ownership (terminal-query-authority.md) for the headless
// emulator, split from headless-emulator.ts (line budget): the reply sink, the
// lazily-built query responder, its CPR cursor read, and the ConPTY/view-
// attribute overrides that only exist once a responder does.
import {
  createTerminalModelQueryResponder,
  type TerminalModelQueryResponder
} from './terminal-model-query-responder'
import type { RustHeadlessTerminalHandle } from './rust-terminal-addon'
import type { TerminalViewAttributes } from '../../shared/terminal-view-attributes'

export type EmulatorQueryAuthorityContext = {
  /** The emulator's engineCall: poison-containing runner for native calls. */
  run<T>(op: string, call: () => T, fallback: () => T): T
  term: RustHeadlessTerminalHandle
  /** Read at reply time — resize() moves it under a live responder. */
  getRows: () => number
  /** Absent for the write-only daemon Session emulator (never answers). */
  onQueryReply?: (reply: string) => void
}

/**
 * Answers DA/DSR/CPR/DECRQM/DECRQSS/XTVERSION/kitty/OSC-color queries from
 * aterm engine state plus the renderer's pushed view attributes, for chunks
 * flagged `forwardQueryReplies`. aterm's headless engine emits no replies of
 * its own, so the reply grammar lives in TerminalModelQueryResponder, not the
 * native addon; this type owns that responder's lifecycle and its sink.
 */
export class HeadlessEmulatorQueryAuthority {
  private responder: TerminalModelQueryResponder | null = null
  // Read at reply time so mute() can silence a respawn-reused session id.
  private sink: ((reply: string) => void) | null

  constructor(private readonly ctx: EmulatorQueryAuthorityContext) {
    this.sink = ctx.onQueryReply ?? null
    // Only the runtime per-PTY emulators pass a sink; the daemon Session
    // emulator omits it and never builds a responder (stays write-only).
    if (this.sink) {
      this.ensureResponder()
    }
  }

  /** Build lazily so a write-only emulator (no sink, no view-attr responder,
   *  no ConPTY override) never carries one. */
  private ensureResponder(): TerminalModelQueryResponder {
    this.responder ??= createTerminalModelQueryResponder({
      emitReply: (reply) => this.sink?.(reply),
      getCursor: () => this.readCursor(),
      getRows: () => this.ctx.getRows()
    })
    return this.responder
  }

  private readCursor(): [number, number] {
    return this.ctx.run(
      'cursor',
      () => {
        const [row, col] = this.ctx.term.cursor()
        return [row, col] as [number, number]
      },
      () => [0, 0]
    )
  }

  /** Called after the engine parse so CPR reads the post-write cursor; state
   *  tracking (OSC SET overrides, mode flags) runs even when replies are off. */
  ingest(data: string, forwardQueryReplies: boolean): void {
    this.responder?.ingest(data, forwardQueryReplies)
  }

  /** A resize resets the scroll region to the full viewport (DECSTBM), so the
   *  responder's margin cache must follow. */
  onResize(): void {
    this.responder?.onResize()
  }

  /** The OSC-color + ?996n family needs this responder installed; colors stay
   *  silent until the first renderer push. */
  installViewAttributeResponder(getter: () => TerminalViewAttributes | null): void {
    this.ensureResponder().setViewAttributesGetter(getter)
  }

  /** Latest renderer push: cursor style/blink feed DECRQSS DECSCUSR and
   *  DECRQM ?12, and the per-PTY OSC color overrides reset. */
  applyPushedViewAttributes(attributes: TerminalViewAttributes): void {
    this.responder?.applyPushedViewAttributes(attributes)
  }

  /** ConPTY 1.22+ blocks at spawn on DA1 and answers it itself with a
   *  different identity; override the DA1 reply to `CSI ?61;4c`. Idempotent. */
  enableConptyDa1Override(): void {
    this.ensureResponder().enableConptyDa1Override()
  }

  /** ConPTY echoes OSC 10/11/12 replies written as PTY input into the prompt
   *  (#6975); mute them. Idempotent. */
  enableConptyOscColorReplySuppression(): void {
    this.ensureResponder().enableConptyOscColorReplySuppression()
  }

  /** Permanently mute at PTY teardown: queued writeChain links may still parse
   *  after dispose, and daemon respawns reuse session ids — a late reply must
   *  never reach a successor PTY under this id. */
  mute(): void {
    this.sink = null
  }
}
