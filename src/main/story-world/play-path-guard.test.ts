/**
 * §7.3 calls this the largest new attack surface in Story World. Every rule here
 * exists because the guard it replaces would have let the request through.
 */
import { describe, expect, it } from 'vitest'
import { decidePlayPath, isAllowedPlayHost, STORY_PLAY_EXTENSIONS } from './play-path-guard'

const ROOT = '/worlds/kitty'
// Identity realpath: no symlinks, so only the lexical rules are under test.
const plain = (path: string): string => path

const decide = (requestPath: string, realpath = plain) =>
  decidePlayPath({ root: ROOT, requestPath, realpath })

describe('serving a game', () => {
  it('allows the files a game is made of', () => {
    expect(decide('/index.html')).toEqual({ allowed: true, absolutePath: '/worlds/kitty/index.html' })
    expect(decide('/game.js').allowed).toBe(true)
    expect(decide('/art/cat.png').allowed).toBe(true)
  })

  it('refuses anything not on the extension allowlist', () => {
    // A world folder can contain .env, .pem, notes.txt — none of which are game.
    for (const path of ['/.env', '/key.pem', '/notes.txt', '/game']) {
      expect(decide(path).allowed).toBe(false)
    }
  })
})

describe('traversal', () => {
  it.each(['/../secrets.js', '/art/../../secrets.js', '/..%2fsecrets.js'])(
    'refuses %s',
    (path) => {
      expect(decide(path).allowed).toBe(false)
    }
  )

  it('decodes exactly once, so double-encoded traversal never becomes live', () => {
    // %252e%252e decodes to the literal segment `%2e%2e`, NOT to `..`. A second
    // decode would turn it into real traversal, which is why there is only one.
    // The property that matters is containment, not refusal: this resolves to a
    // strangely-named file inside the world, which is harmless.
    const decision = decide('/%252e%252e/secrets.js')
    expect(decision).toEqual({
      allowed: true,
      absolutePath: '/worlds/kitty/%2e%2e/secrets.js'
    })
  })

  it('refuses a NUL byte', () => {
    expect(decide('/game.js%00.png')).toMatchObject({ allowed: false, reason: 'nul-byte' })
  })
})

describe('the Windows rules the old sanitizer missed', () => {
  it.each([
    ['a device name', '/CON.js', 'windows-device'],
    ['a lowercase device', '/nul.js', 'windows-device'],
    ['a numbered device', '/com1.js', 'windows-device'],
    ['an alternate data stream', '/game.js::$DATA', 'alternate-data-stream'],
    ['a trailing dot', '/game.js./', 'trailing-dot-or-space']
  ])('refuses %s', (_label, path, reason) => {
    expect(decide(path)).toMatchObject({ allowed: false, reason })
  })

  it('refuses a backslash-separated escape, which Windows treats as a separator', () => {
    expect(decide('\\..\\secrets.js').allowed).toBe(false)
  })
})

describe('symlink containment', () => {
  it('refuses a link that resolves outside the world', () => {
    // The lexical path is impeccable; only realpath catches this. It is the case
    // a relative()-only guard walks straight through.
    const realpath = (path: string): string =>
      path === '/worlds/kitty/pet.png' ? '/home/parent/.ssh/id_rsa' : path
    expect(decide('/pet.png', realpath)).toMatchObject({
      allowed: false,
      reason: 'escapes-root'
    })
  })

  it('allows a link that resolves inside the world', () => {
    const realpath = (path: string): string =>
      path === '/worlds/kitty/pet.png' ? '/worlds/kitty/art/pet.png' : path
    expect(decide('/pet.png', realpath)).toMatchObject({ allowed: true })
  })

  it('refuses when the path cannot be resolved at all', () => {
    const realpath = (): string => {
      throw new Error('ENOENT')
    }
    expect(decide('/index.html', realpath)).toMatchObject({
      allowed: false,
      reason: 'unresolvable'
    })
  })
})

describe('isAllowedPlayHost', () => {
  it('accepts only loopback on the port we minted', () => {
    expect(isAllowedPlayHost('127.0.0.1:5123', 5123)).toBe(true)
    expect(isAllowedPlayHost('localhost:5123', 5123)).toBe(true)
  })

  it.each([
    ['another port', '127.0.0.1:9999'],
    ['a real host', 'evil.example.com:5123'],
    ['no host at all', undefined]
  ])('refuses %s', (_label, host) => {
    expect(isAllowedPlayHost(host, 5123)).toBe(false)
  })
})

describe('the extension allowlist', () => {
  it('carries no executable or config formats', () => {
    for (const banned of ['.sh', '.exe', '.env', '.pem', '.ts']) {
      expect(STORY_PLAY_EXTENSIONS).not.toContain(banned)
    }
  })
})
