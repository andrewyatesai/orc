import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { runPreflightCommandInWsl } from './preflight-wsl-command'

// Stock Ubuntu's interactive login shell prints this to stdout ahead of the
// payload -- the noise the fence exists to drop.
const BANNER = 'To run a command as administrator (user "root"), use "sudo <command>".\n\n'

/** Stand in for the guest shell: banner first, then the payload inside the command's own fence. */
function respondWithFencedPayload(payload: string): void {
  execFileMock.mockImplementation((_file, args, _options, callback) => {
    const script = String((args as string[]).at(-1))
    const nonce = /__ORCA_WSL_CAPTURE_BEGIN_([^_]+)__/.exec(script)?.[1] ?? ''
    const stdout = `${BANNER}__ORCA_WSL_CAPTURE_BEGIN_${nonce}__${payload}__ORCA_WSL_CAPTURE_END_${nonce}__`
    // promisify(execFile) resolves the value at the first non-error callback slot;
    // the real execFile custom-promisify shape is { stdout, stderr }.
    callback(null, { stdout, stderr: '' })
  })
}

describe('runPreflightCommandInWsl', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns only the fenced payload, dropping the login-shell banner', async () => {
    respondWithFencedPayload('gh version 2.40.0 (2024-01-01)\n')

    const result = await runPreflightCommandInWsl({ distro: 'Ubuntu' }, 'gh --version', 5_000)

    // Unfenced, a version/auth matcher would read the sudo hint and see no CLI.
    expect(result.stdout).toBe('gh version 2.40.0 (2024-01-01)\n')
    expect(result.stdout).not.toContain('sudo')
  })

  it('passes the distro and fences the command it runs', async () => {
    respondWithFencedPayload('ok\n')

    await runPreflightCommandInWsl({ distro: 'Ubuntu' }, 'gh --version', 5_000)

    const args = execFileMock.mock.calls[0]?.[1] as string[]
    expect(args.slice(0, 2)).toEqual(['-d', 'Ubuntu'])
    expect(String(args.at(-1))).toContain('__ORCA_WSL_CAPTURE_BEGIN_')
  })

  it('keeps the raw stdout when the fence never appeared', async () => {
    // A crash before the payload leaves the matchers their prefix-tolerant blob.
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: `${BANNER}bash: gh: command not found\n`, stderr: '' })
    })

    const result = await runPreflightCommandInWsl({ distro: 'Ubuntu' }, 'gh --version', 5_000)

    expect(result.stdout).toContain('command not found')
  })
})
