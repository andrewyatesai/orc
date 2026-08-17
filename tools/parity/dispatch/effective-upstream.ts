// TS dispatch for the effective-upstream parity module. `splitRemoteBranchName`
// was CUT OVER, so this drives the SHIM — and config/vitest.parity.config.ts
// installs no setup file, which means the seam is unbound here and the shim
// answers from its `parity` fallback. That is the deleted body, so this leg is
// still a real differential (fallback vs Rust), not a self-comparison.

import { splitRemoteBranchName } from '../../../src/shared/git-remote-branch-split'

export function dispatch(fn: string, input: unknown): unknown {
  switch (fn) {
    case 'splitRemoteBranchName':
      return splitRemoteBranchName(input as string)
    default:
      throw new Error(`unknown function ${fn}`)
  }
}
