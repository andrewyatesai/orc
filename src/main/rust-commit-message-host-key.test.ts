import { describe, expect, it } from 'vitest'
import { loadRustGitBinding } from './daemon/rust-git-addon'
import { getCommitMessageModelDiscoveryHostKey } from './rust-commit-message-host-key'
import {
  LOCAL_COMMIT_MESSAGE_HOST_KEY,
  UNKNOWN_COMMIT_MESSAGE_HOST_KEY
} from '../shared/commit-message-host-key'

// The deleted TS twin's mapping, pinned against the napi path: main has no
// pre-ready fallback to compare with, so these goldens are the only thing that
// keeps the connection-id form from drifting when the core changes.
//
// Skips cleanly when the .node is absent (CI without a native build).
const suite = loadRustGitBinding() ? describe : describe.skip

suite('rust-commit-message-host-key (napi)', () => {
  it('maps an undefined connection to unknown and no connection to local', () => {
    expect(getCommitMessageModelDiscoveryHostKey(undefined)).toBe(UNKNOWN_COMMIT_MESSAGE_HOST_KEY)
    expect(getCommitMessageModelDiscoveryHostKey(null)).toBe(LOCAL_COMMIT_MESSAGE_HOST_KEY)
    expect(getCommitMessageModelDiscoveryHostKey('')).toBe(LOCAL_COMMIT_MESSAGE_HOST_KEY)
  })

  it('namespaces a connection id under ssh:', () => {
    expect(getCommitMessageModelDiscoveryHostKey('conn-1')).toBe('ssh:conn-1')
    expect(getCommitMessageModelDiscoveryHostKey('runtime-ssh-env-1')).toBe(
      'ssh:runtime-ssh-env-1'
    )
    expect(getCommitMessageModelDiscoveryHostKey('😀-conn')).toBe('ssh:😀-conn')
  })

  // The one input where the scope entry (the module's only registered function)
  // differs from the deleted connection-id twin, which returned 'ssh:runtime:x'.
  // Unreachable: `runtime:` is the execution-host namespace, never a connection
  // id — pinned so the difference cannot change meaning unnoticed.
  it('passes a runtime-prefixed value through instead of ssh-namespacing it', () => {
    expect(getCommitMessageModelDiscoveryHostKey('runtime:env-1')).toBe('runtime:env-1')
  })
})
