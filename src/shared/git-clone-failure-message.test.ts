import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGitCloneFailureMessage } from './git-clone-failure-message'

afterEach(() => {
  vi.restoreAllMocks()
})

// The scrub itself is the Rust orca-text core's (asserted in
// rust/crates/orca-text/src/git_remote_error.rs and, at the JS boundary, in
// src/renderer/src/lib/git-wasm/git-remote-error.test.ts). This shared
// formatter only has to route stderr through whatever the caller injected
// BEFORE it matches, so these tests inject a stub and assert that ordering.
const passthrough = (message: string): string => message

function format(stderr: string, options: { clonePath?: string | null } = {}): string {
  return getGitCloneFailureMessage(stderr, { ...options, stripCredentials: passthrough })
}

describe('getGitCloneFailureMessage', () => {
  it('turns an existing destination into an actionable message after progress output', () => {
    expect(
      format(
        [
          'Cloning into \u001b[32morca\u001b[0m...\r',
          "fatal: destination path 'orca' already exists and is not an empty directory.\n"
        ].join(''),
        { clonePath: '/work/orca' }
      )
    ).toBe(
      'Destination already exists and is not empty: /work/orca. Choose a different parent folder, delete the existing folder, or add the existing repository instead.'
    )
  })

  it('prefers the last fatal line over a trailing fragment', () => {
    expect(
      format(
        "fatal: destination path 'orca' already exists and is not an empty directory.\r\nand the repository exists.\n"
      )
    ).toBe(
      'Destination already exists and is not empty: orca. Choose a different parent folder, delete the existing folder, or add the existing repository instead.'
    )
  })

  it('uses the known clone path for relay destination fragments', () => {
    expect(format('Clone failed: and the repository exists.', { clonePath: '/srv/orca' })).toBe(
      'Destination already exists and is not empty: /srv/orca. Choose a different parent folder, delete the existing folder, or add the existing repository instead.'
    )
  })

  it('falls back to the last non-empty line', () => {
    expect(format('warning: retrying\nnetwork vanished\n')).toBe('network vanished')
  })

  it('routes stderr through the injected scrub before matching a line', () => {
    // Clone errors echo the URL the user typed — the most likely git error to
    // embed a live token — and the message reaches dialogs and bug reports.
    // Every return branch must operate on already-redacted text.
    const stderr =
      'Cloning into repo...\n' +
      "fatal: repository 'https://user:ghp_secret123@github.com/org/repo.git/' not found\n"
    const stripCredentials = vi.fn((message: string) => message.replace('user:ghp_secret123@', ''))

    expect(getGitCloneFailureMessage(stderr, { stripCredentials })).toBe(
      "fatal: repository 'https://github.com/org/repo.git/' not found"
    )
    expect(stripCredentials).toHaveBeenCalledExactlyOnceWith(stderr)
  })

  it('summarizes CRLF-heavy stderr without line-array splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const stderr = `${'remote: counting objects\r\n'.repeat(10_000)}fatal: repository not found\r\n`

    expect(format(stderr)).toBe('fatal: repository not found')

    const usedLineSplit = splitSpy.mock.calls.some(
      ([separator]) =>
        (typeof separator === 'string' && separator === '\n') ||
        (separator instanceof RegExp && separator.source === '\\r?\\n')
    )
    expect(usedLineSplit).toBe(false)
  })
})
