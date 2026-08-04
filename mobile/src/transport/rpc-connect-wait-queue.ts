type ConnectWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

/** Callers parked until the RPC channel reaches 'connected'. Owns each waiter's
 *  timeout so an expired wait drops its queue entry instead of leaking one. */
export class RpcConnectWaitQueue {
  private readonly waiters: ConnectWaiter[] = []

  wait(timeoutMs?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: ConnectWaiter = { resolve, reject, timeout: null }
      if (timeoutMs !== undefined) {
        // Why: per-request timeouts must cover offline/reconnect waiting, not just the RPC after connect.
        waiter.timeout = setTimeout(
          () => {
            this.forget(waiter)
            reject(new Error('Timed out while connecting to the remote Orca runtime.'))
          },
          Math.max(0, timeoutMs)
        )
      }
      this.waiters.push(waiter)
    })
  }

  resolveAll(): void {
    for (const waiter of this.drain()) {
      waiter.resolve()
    }
  }

  rejectAll(reason: string): void {
    const error = new Error(reason)
    for (const waiter of this.drain()) {
      waiter.reject(error)
    }
  }

  private drain(): ConnectWaiter[] {
    const drained = this.waiters.splice(0)
    for (const waiter of drained) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout)
      }
    }
    return drained
  }

  private forget(waiter: ConnectWaiter): void {
    const index = this.waiters.indexOf(waiter)
    if (index !== -1) {
      this.waiters.splice(index, 1)
    }
  }
}
