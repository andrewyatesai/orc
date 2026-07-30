import { createRequire } from 'node:module'
import type * as Ssh2 from 'ssh2'

// Why: ssh2 is a ~25ms require (crypto setup + cpu-features probe) on the
// main-process startup path, paid on every cold launch even for users who never
// open an SSH connection. Load it lazily via createRequire so launch skips it;
// the accessor stays synchronous so connection/auth code doesn't become async.
// Kept in its own module (mirrors linear-sdk.ts) so tests can mock the loader.
export type Ssh2Module = typeof Ssh2

const requireFromMain = createRequire(__filename)
let cached: Ssh2Module | null = null

export function loadSsh2(): Ssh2Module {
  cached ??= requireFromMain('ssh2') as Ssh2Module
  return cached
}
