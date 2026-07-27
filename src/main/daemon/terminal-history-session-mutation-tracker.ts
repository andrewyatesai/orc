// Why: recovery freeze and session removal must observe a quiesced store, so every
// in-flight history write is tracked per session and awaited before they proceed.
export class TerminalHistorySessionMutationTracker {
  private pendingSessionMutations = new Map<string, Set<Promise<unknown>>>()

  trackSessionMutation<T>(sessionId: string, operation: Promise<T>): Promise<T> {
    const mutations = this.pendingSessionMutations.get(sessionId) ?? new Set<Promise<unknown>>()
    mutations.add(operation)
    this.pendingSessionMutations.set(sessionId, mutations)
    void operation.then(
      () => this.finishSessionMutation(sessionId, operation),
      () => this.finishSessionMutation(sessionId, operation)
    )
    return operation
  }

  private finishSessionMutation(sessionId: string, operation: Promise<unknown>): void {
    const mutations = this.pendingSessionMutations.get(sessionId)
    mutations?.delete(operation)
    if (mutations?.size === 0) {
      this.pendingSessionMutations.delete(sessionId)
    }
  }

  async waitForSessionMutations(sessionId: string): Promise<void> {
    while (this.pendingSessionMutations.has(sessionId)) {
      await Promise.allSettled(this.pendingSessionMutations.get(sessionId) ?? [])
    }
  }
}
