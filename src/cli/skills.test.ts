import { beforeEach, describe, expect, it, vi } from 'vitest'

const { guideModuleLoadMock, runtimeClientConstructorMock } = vi.hoisted(() => ({
  guideModuleLoadMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn()
}))

vi.mock('./bundled-skill-guides.js', () => {
  guideModuleLoadMock()
  return {
    BUNDLED_SKILL_GUIDES: [
      {
        name: 'zeta',
        description: 'Use when zeta work\nspans lines.',
        markdown: '# Zeta\n',
        fullMarkdown: '# Zeta\n\n## References\n\nZeta reference.\n',
        aliases: []
      },
      {
        name: 'alpha',
        description: 'Use when alpha work is needed.',
        markdown: '# Alpha\n\nShort.\n',
        fullMarkdown: '# Alpha\n\nShort.\n\n## References\n\nFull.\n',
        aliases: ['legacy-alpha']
      }
    ]
  }
})

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    constructor() {
      runtimeClientConstructorMock()
    }
  }

  class RuntimeClientError extends Error {
    readonly code: string
    readonly data?: unknown

    constructor(code: string, message: string, data?: unknown) {
      super(message)
      this.code = code
      this.data = data
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn(),
    getDefaultUserDataPath: vi.fn(() => '/tmp/orca-user-data')
  }
})

// Why: force a bare host — no agent detected — so the headless install refusal is
// deterministic instead of depending on what is installed on the test machine.
vi.mock('../main/ipc/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: () => new Set<string>()
}))

import { dispatch } from './dispatch'
import { main } from './index'
import { ORCA_SKILLS_REPOSITORY_URL } from '../shared/agent-feature-install-commands'

describe('orca skills CLI', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    runtimeClientConstructorMock.mockClear()
    process.exitCode = undefined
  })

  it('keeps the bundled table off the eager command-registry path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(guideModuleLoadMock).not.toHaveBeenCalled()
    await main(['status', '--help'], '/tmp/repo')
    expect(guideModuleLoadMock).not.toHaveBeenCalled()
  })

  it('dispatches an alias locally and emits the exact Markdown', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await dispatch(['skills', 'get'], {
      flags: new Map([['topic', 'legacy-alpha']]),
      get client(): never {
        throw new Error('skills get accessed RuntimeClient')
      },
      cwd: '/tmp/repo',
      json: false
    })

    expect(stdoutText(stdoutSpy)).toBe('# Alpha\n\nShort.\n')
  })

  it('lists canonical topics deterministically without constructing RuntimeClient', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'list'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      'alpha: Use when alpha work is needed.\nzeta: Use when zeta work spans lines.\n'
    )
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('emits full Markdown for --full', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'alpha', '--full'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe('# Alpha\n\nShort.\n\n## References\n\nFull.\n')
  })

  it('supports the canonical single-item show verb as an alias', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'show', 'alpha'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe('# Alpha\n\nShort.\n')
  })

  it('gives list --json a stable canonical schema', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'list', '--json'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          topics: [
            { name: 'alpha', description: 'Use when alpha work is needed.' },
            { name: 'zeta', description: 'Use when zeta work spans lines.' }
          ]
        },
        null,
        2
      )}\n`
    )
  })

  it('gives alias get --json the canonical name, selection, and Markdown', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'legacy-alpha', '--full', '--json'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          name: 'alpha',
          full: true,
          markdown: '# Alpha\n\nShort.\n\n## References\n\nFull.\n'
        },
        null,
        2
      )}\n`
    )
  })

  it('shows leaf, group, and root help for skills', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['skills', 'get', '--help'], '/tmp/repo')
    await main(['skills', '--help'], '/tmp/repo')
    await main(['--help'], '/tmp/repo')

    expect(String(logSpy.mock.calls[0]?.[0])).toContain(
      'Usage: orca skills get <topic> [--full] [--json]'
    )
    expect(String(logSpy.mock.calls[1]?.[0])).toContain(
      'Commands:\n  list               List version-matched skill guides'
    )
    expect(String(logSpy.mock.calls[1]?.[0])).toContain(
      'get                Print a version-matched skill guide'
    )
    expect(String(logSpy.mock.calls[2]?.[0])).toContain('Skills:\n  skills list')
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('returns a nonzero error with all canonical topics for an unknown topic', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'get', 'missing'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Unknown skill topic "missing". Available topics: alpha, zeta'
    )
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })
})

describe('orca skills install/update (headless)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    runtimeClientConstructorMock.mockClear()
    delete process.env.ORCA_CLI_CWD
    process.exitCode = undefined
  })

  it('renders the exact npx argv for a scoped --dry-run install without spawning', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(
      ['skills', 'install', '--skill', 'alpha', '--agent', 'universal', '--dry-run'],
      '/tmp/repo'
    )

    expect(stdoutText(stdoutSpy)).toBe(
      `npx --yes skills add ${ORCA_SKILLS_REPOSITORY_URL} --skill alpha --global --agent universal -y\n\n` +
        'Rerun without --dry-run to install now.\n'
    )
    expect(process.exitCode).toBeUndefined()
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('scopes to the current project with --local and rejects unknown skills', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'update', '--skill', 'alpha', '--local', '--dry-run'], '/tmp/repo')
    expect(stdoutText(stdoutSpy)).toBe(
      'npx --yes skills update alpha --project -y\n\nRerun without --dry-run to update now.\n'
    )

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(['skills', 'install', '--skill', 'missing'], '/tmp/repo')
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain(
      'Unknown skill "missing". Available skills: alpha, zeta'
    )
  })

  it('lists installable skills when neither --skill nor --all is given', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      [
        'Choose one or more skills to install:',
        '  alpha',
        '  zeta',
        '',
        'Usage: orca skills install --skill <name> [--skill <name> ...]',
        '   or: orca skills install --all\n'
      ].join('\n')
    )
  })

  it('refuses a real install with --json because npx output is not JSON', async () => {
    // Why: --json routes the failure through console.log as a JSON envelope.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['skills', 'install', '--skill', 'alpha', '--agent', 'universal', '--json'],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(1)
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain(
      'orca skills install --json only supports --dry-run'
    )
  })

  it('refuses to install with no detected agent and no explicit --agent', async () => {
    // Why: the whole point of the feature — a bare headless host must not fan out
    // into ~75 agent config directories, so an empty detection refuses loudly.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha', '--dry-run'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain(
      'No coding agent detected on this host'
    )
  })

  it('rejects an --agent value the skills CLI would silently drop', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha', '--agent', '-y'], '/tmp/repo')
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain('Invalid --agent value "-y"')

    process.exitCode = undefined
    await main(['skills', 'install', '--skill', 'alpha', '--agent', ','], '/tmp/repo')
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain('Missing required --agent')
  })

  it('refuses to write to the wrong host when the shell forwards orca', async () => {
    process.env.ORCA_CLI_CWD = '/remote/project'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['skills', 'install', '--skill', 'alpha', '--agent', 'universal', '--dry-run'],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain('writes to the machine that runs it')
  })
})

function stdoutText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}
