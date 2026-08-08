import { app } from 'electron'

/**
 * The single sanctioned answer to "may this secret be written to disk in cleartext?".
 *
 * Every credential store in the main process must ask this one predicate. A copy of the
 * body cannot share an opt-in: the point of the flag is that one decision, audited in one
 * place, governs every store — and `config/scripts/credential-write-policy-guard.mjs`
 * resolves guarded writes by *declaration identity*, so a duplicate is a different
 * declaration and gates nothing it did not itself declare.
 */

// Why: named so stores can quote the exact flag in their refusal message instead of re-typing it.
export const PLAINTEXT_SECRET_OPT_IN_ENV = 'ORCA_ALLOW_PLAINTEXT_PERSISTED_SECRETS'

// Why tag persisted secrets by how they were stored: a plaintext value must never be silently read
// back and trusted as if it were decrypted ciphertext, and a genuine ciphertext must never be mistaken
// for plaintext (which would double-encrypt or leak it). Untagged legacy values keep their old meaning.
export const ENCRYPTED_SECRET_PREFIX = 'orca-safestorage-v1:'
export const PLAINTEXT_SECRET_PREFIX = 'orca-plaintext-v1:'

// Why the try/catch: `app` is undefined under unit tests and throws when touched outside a live
// Electron main process; an unreadable packaging flag must fail closed to "not packaged is unknown",
// which is safe here only because the env opt-in is still required.
function isPackagedBuild(): boolean {
  try {
    return app?.isPackaged === true
  } catch {
    return false
  }
}

// Why: production — especially the headless/SSH Linux hosts this fork targets, where safeStorage is
// routinely unavailable — must never silently persist secrets in cleartext. A dev may opt in
// explicitly, and only in an unpackaged non-production build.
export function allowsPlaintextPersistedSecret(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env[PLAINTEXT_SECRET_OPT_IN_ENV] === '1' && env.NODE_ENV !== 'production' && !isPackagedBuild()
  )
}
