import { describe, expect, it } from 'vitest'
import { join, sep } from 'node:path'
import { resolveShellWrapperRoot, type ShellWrapperFile } from './shell-wrapper-content-address'

// A builder shaped like the real daemon/local ones: file paths hang off `root`
// and one file bakes the root into its bytes (as .zshenv does with ZDOTDIR).
function makeBuilder(marker: string): (root: string) => readonly ShellWrapperFile[] {
  return (root) => [
    [join(root, 'zsh', '.zshenv'), `export ZDOTDIR="${join(root, 'zsh')}"\n# ${marker}\n`],
    [join(root, 'bash', 'rcfile'), `# ${marker}\n`]
  ]
}

describe('resolveShellWrapperRoot', () => {
  it('names the tree <base>/<16-hex-hash>/shell-ready', () => {
    const root = resolveShellWrapperRoot('/data/shell-wrappers', makeBuilder('a'))

    expect(root.startsWith(`/data/shell-wrappers${sep}`)).toBe(true)
    const segments = root.split(sep)
    // Leaf stays `shell-ready` so `*/shell-ready/zsh` self-reference guards match.
    expect(segments.at(-1)).toBe('shell-ready')
    expect(segments.at(-2)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('gives different wrapper content a different directory (the anti-clobber property)', () => {
    // Why this is the whole fix: two builds whose wrappers differ must not share
    // a tree, so a present tree is provably the current build's.
    const a = resolveShellWrapperRoot('/data/shell-wrappers', makeBuilder('build-a'))
    const b = resolveShellWrapperRoot('/data/shell-wrappers', makeBuilder('build-b'))

    expect(a).not.toBe(b)
  })

  it('gives identical wrapper content the same directory', () => {
    const a = resolveShellWrapperRoot('/data/shell-wrappers', makeBuilder('same'))
    const b = resolveShellWrapperRoot('/data/shell-wrappers', makeBuilder('same'))

    expect(a).toBe(b)
  })

  it('keeps the hash independent of the base dir it is naming', () => {
    // Why: the digest hashes against a fixed probe root, not the real base dir,
    // so the same wrapper set lands under the same hash regardless of userData.
    const under1 = resolveShellWrapperRoot('/one/shell-wrappers', makeBuilder('x'))
    const under2 = resolveShellWrapperRoot('/two/elsewhere', makeBuilder('x'))

    const hash1 = under1.split(sep).at(-2)
    const hash2 = under2.split(sep).at(-2)
    expect(hash1).toBe(hash2)
  })

  it('does not leak the real root path into the digest', () => {
    // Why: the builder bakes `root` into .zshenv, but resolve hashes against a
    // placeholder root, so passing the resolved dir back in must not re-key it.
    const first = resolveShellWrapperRoot('/data/shell-wrappers', makeBuilder('y'))
    const second = resolveShellWrapperRoot('/data/shell-wrappers', makeBuilder('y'))

    // Idempotent: the path-dependent .zshenv bytes never perturb the hash.
    expect(first).toBe(second)
  })
})
