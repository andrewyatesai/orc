// The sentinel handler, exercised through the production loader rather than a
// hand-built double: `inspectMcpConfigContent` answers `null` for real content
// until the wasm core lands, and a config file that EXISTS must not get an
// invented row. The order matters — the refusal case has to run before the
// core is initialised, so it is the first `it` in the file.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initGitWasmForTestFromBytes } from '../../lib/git-wasm/git-line-stats'
import {
  loadMcpConfigInspections,
  McpConfigInspectionUnavailableError
} from './mcp-config-inspection'

function stubWorkspaceWithMcpJson(content: string): void {
  stubWorkspaceFiles({ '.mcp.json': content })
}

/** Only the fs IPC is stubbed: the loader, the wasm shim, the dispatch codec and
 *  the Rust core are all the production ones. */
function stubWorkspaceFiles(contentByRelativePath: Record<string, string>): void {
  vi.stubGlobal('window', {
    api: {
      fs: {
        readDir: ({ dirPath }: { dirPath: string }) =>
          Promise.resolve(
            dirPath === '/repo'
              ? Object.keys(contentByRelativePath).map((name) => ({ name, isDirectory: false }))
              : []
          ),
        readFile: ({ filePath }: { filePath: string }) => {
          const content = contentByRelativePath[filePath.replace('/repo/', '')]
          return content === undefined
            ? Promise.reject(new Error(`ENOENT: no such file ${filePath}`))
            : Promise.resolve({ content, isBinary: false })
        }
      }
    }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadMcpConfigInspections', () => {
  it('refuses rather than summarizing a config the core cannot inspect yet', async () => {
    stubWorkspaceWithMcpJson('{"mcpServers":{"a":{"command":"node"}}}')

    await expect(loadMcpConfigInspections('/repo', undefined)).rejects.toBeInstanceOf(
      McpConfigInspectionUnavailableError
    )
  })

  it('summarizes the config once the core is ready', async () => {
    initGitWasmForTestFromBytes(
      readFileSync(new URL('../../lib/git-wasm/orca_git_wasm_bg.wasm', import.meta.url))
    )
    stubWorkspaceWithMcpJson('{"mcpServers":{"a":{"command":"node"}}}')

    const inspections = await loadMcpConfigInspections('/repo', undefined)
    const workspace = inspections.find((entry) => entry.candidate.relativePath === '.mcp.json')

    expect(workspace).toMatchObject({
      exists: true,
      status: 'valid',
      servers: [{ name: 'a', transport: 'stdio', status: 'enabled', command: 'node' }]
    })
    // The candidates whose file is absent still answer, ready or not.
    expect(inspections.filter((entry) => entry.status === 'missing')).toHaveLength(3)
  })

  it('charges one unreadable config one row, not the whole pane', async () => {
    initGitWasmForTestFromBytes(
      readFileSync(new URL('../../lib/git-wasm/orca_git_wasm_bg.wasm', import.meta.url))
    )
    // A REAL lone surrogate (not the escape): the dispatch codec refuses to
    // encode it, so the seam throws for this file and only this file.
    stubWorkspaceFiles({
      '.mcp.json': '{"mcpServers":{"a\ud800":{"command":"node"}}}',
      '.claude.json': '{"mcpServers":{"healthy":{"command":"node"}}}'
    })

    const inspections = await loadMcpConfigInspections('/repo', undefined)

    expect(
      inspections.find((entry) => entry.candidate.relativePath === '.claude.json')
    ).toMatchObject({ status: 'valid', servers: [{ name: 'healthy' }] })
    const workspace = inspections.find((entry) => entry.candidate.relativePath === '.mcp.json')
    expect(workspace).toMatchObject({ exists: true, status: 'invalid', servers: [] })
    expect(workspace?.readError).toContain('unpaired UTF-16 surrogate')
  })
})
