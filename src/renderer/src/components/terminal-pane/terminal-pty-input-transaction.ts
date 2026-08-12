// Serializes multi-step PTY input flows (paste + submit Enter) per PTY so a
// concurrent write on the same target can't slip between them and submit a
// half-written prompt or corrupt one bracketed-paste frame.
const transactionTails = new Map<string, Promise<void>>()

export function runTerminalPtyInputTransaction<T>(
  ptyId: string,
  run: () => Promise<T>
): Promise<T> {
  const prior = transactionTails.get(ptyId)
  // Why: an idle PTY runs inline so the first write lands in the caller's turn
  // (callers rely on it firing synchronously); a busy PTY queues onto the tail.
  const result = prior ? prior.then(run, run) : run()
  // Why: chained followers must observe a settled, never-rejecting tail, or one
  // failing transaction would release the next early.
  const tail = result.then(
    () => {},
    () => {}
  )
  transactionTails.set(ptyId, tail)
  void tail.then(() => {
    if (transactionTails.get(ptyId) === tail) {
      transactionTails.delete(ptyId)
    }
  })
  return result
}
