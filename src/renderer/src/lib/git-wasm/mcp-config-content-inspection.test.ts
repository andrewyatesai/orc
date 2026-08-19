// The mcp twin's own inspection tests, moved here with the implementation.
//
// Two of them changed shape rather than intent. The twin's versions spied on
// `JSON.parse` to prove the size bound answers BEFORE the parser sees the text;
// the parser is now inside the wasm and unobservable from here, so they assert
// the size bound's own error string instead — a parse failure would report V8's
// or serde's message, never that sentence.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { inspectMcpConfigContent } from './mcp-config-content-inspection'
import { initGitWasmForTestFromBytes } from './git-line-stats'
import { MCP_CONFIG_CANDIDATES, MCP_STARTER_CONFIG } from '../../../../shared/mcp-config'
import type { McpConfigInspection } from '../../../../shared/mcp-config'
import {
  MCP_CONFIG_INSPECTION_MAX_BYTES,
  MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS,
  MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES,
  MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS,
  MCP_CONFIG_INSPECTION_MAX_SERVERS
} from '../../../../shared/mcp-config-inspection-limits'

const OVERSIZE_ERROR = 'MCP config exceeds the inspection size limit.'

beforeAll(() => {
  initGitWasmForTestFromBytes(readFileSync(new URL('./orca_git_wasm_bg.wasm', import.meta.url)))
})

describe('mcp-config-content-inspection', () => {
  const workspaceCandidate = MCP_CONFIG_CANDIDATES[0]

  // A ready core always answers an object; `null` here would mean the beforeAll
  // init silently failed and every assertion below was vacuous.
  function inspect(content: string): McpConfigInspection {
    const result = inspectMcpConfigContent(workspaceCandidate, content)
    if (!result) {
      throw new Error('the wasm core is not ready, so these cases prove nothing')
    }
    return result
  }

  it('reports missing configs', () => {
    expect(inspectMcpConfigContent(workspaceCandidate, null)).toMatchObject({
      exists: false,
      status: 'missing',
      servers: []
    })
  })

  it('reports invalid JSON without exposing file contents', () => {
    const result = inspect('{')
    expect(result.status).toBe('invalid')
    expect(result.error).toContain('JSON')
    expect(result.error).not.toContain('{')
    expect(result.servers).toEqual([])
  })

  it('summarizes stdio, http, disabled, and invalid servers', () => {
    const result = inspect(
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
            env: { NODE_ENV: 'production', API_TOKEN: 'secret-token' }
          },
          docs: { type: 'http', url: 'https://example.com/mcp' },
          old: { command: 'node', enabled: false },
          broken: { args: ['missing-command'] }
        }
      })
    )

    expect(result.status).toBe('valid')
    expect(result.servers).toEqual([
      {
        name: 'filesystem',
        transport: 'stdio',
        status: 'enabled',
        command: 'npx',
        env: { NODE_ENV: 'production', API_TOKEN: '••••••••' }
      },
      {
        name: 'docs',
        transport: 'http',
        status: 'enabled',
        url: 'https://example.com/mcp'
      },
      {
        name: 'old',
        transport: 'stdio',
        status: 'disabled',
        command: 'node'
      },
      {
        name: 'broken',
        transport: 'unknown',
        status: 'invalid',
        issue: 'Missing command or URL.'
      }
    ])
  })

  it('supports agent-specific command and URL shapes from common adapters', () => {
    const result = inspect(
      JSON.stringify({
        mcpServers: {
          opencodeLocal: { type: 'local', command: ['uvx', 'server'] },
          geminiRemote: { httpUrl: 'https://example.com/sse' }
        }
      })
    )

    expect(result.servers).toMatchObject([
      { name: 'opencodeLocal', transport: 'stdio', command: 'uvx' },
      { name: 'geminiRemote', transport: 'http', url: 'https://example.com/sse' }
    ])
  })

  it('marks declared transports without their target as invalid', () => {
    const result = inspect(
      JSON.stringify({
        mcpServers: {
          remoteMissingUrl: { type: 'http' },
          localMissingCommand: { type: 'local' }
        }
      })
    )

    expect(result.servers).toEqual([
      {
        name: 'remoteMissingUrl',
        transport: 'http',
        status: 'invalid',
        issue: 'Missing URL.'
      },
      {
        name: 'localMissingCommand',
        transport: 'stdio',
        status: 'invalid',
        issue: 'Missing command.'
      }
    ])
  })

  it('keeps starter config valid and empty', () => {
    expect(inspect(MCP_STARTER_CONFIG)).toMatchObject({
      exists: true,
      status: 'valid',
      servers: []
    })
  })

  it('parses the exact input boundary and rejects +1 with the size answer', () => {
    const exact = `${' '.repeat(MCP_CONFIG_INSPECTION_MAX_BYTES - 2)}{}`

    expect(inspect(exact).status).toBe('valid')
    expect(inspect(`${exact} `)).toMatchObject({ status: 'invalid', error: OVERSIZE_ERROR })
  })

  it('rejects multibyte input over the byte cap with the size answer, not a parse error', () => {
    // Not JSON either, so only a bound checked before parsing can produce this.
    const result = inspect('é'.repeat(MCP_CONFIG_INSPECTION_MAX_BYTES / 2 + 1))
    expect(result).toMatchObject({ status: 'invalid', error: OVERSIZE_ERROR })
  })

  it('admits the exact server cardinality and rejects +1', () => {
    const servers: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: MCP_CONFIG_INSPECTION_MAX_SERVERS }, (_, index) => [
        `server-${index}`,
        { command: 'node' }
      ])
    )

    expect(inspect(JSON.stringify({ mcpServers: servers })).servers).toHaveLength(
      MCP_CONFIG_INSPECTION_MAX_SERVERS
    )
    servers.overflow = { command: 'node' }
    expect(inspect(JSON.stringify({ mcpServers: servers }))).toMatchObject({
      status: 'invalid',
      servers: [],
      error: 'MCP server collection exceeds the inspection limits.'
    })
  })

  it('admits an exact-size command and rejects the field at +1', () => {
    const exact = 'x'.repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_CODE_UNITS)
    const exactUtf8 = 'é'.repeat(MCP_CONFIG_INSPECTION_MAX_FIELD_BYTES / 2)
    const inspectCommand = (command: string) =>
      inspect(JSON.stringify({ mcpServers: { bounded: { command } } })).servers[0]

    expect(inspectCommand(exact)).toMatchObject({ status: 'enabled', command: exact })
    expect(inspectCommand(`${exact}x`)).toMatchObject({
      status: 'invalid',
      issue: 'Command exceeds the MCP inspection field limit.'
    })
    expect(inspectCommand(exactUtf8)).toMatchObject({ status: 'enabled', command: exactUtf8 })
    expect(inspectCommand(`${exactUtf8}é`)).toMatchObject({
      status: 'invalid',
      issue: 'Command exceeds the MCP inspection field limit.'
    })
  })

  it('admits the exact env cardinality and rejects +1 without retaining env values', () => {
    const env: Record<string, string> = Object.fromEntries(
      Array.from({ length: MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS }, (_, index) => [
        `KEY_${index}`,
        'value'
      ])
    )
    const inspectEnv = () =>
      inspect(JSON.stringify({ mcpServers: { bounded: { command: 'node', env } } })).servers[0]

    expect(Object.keys(inspectEnv()?.env ?? {})).toHaveLength(MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS)
    env.OVERFLOW = 'value'
    expect(inspectEnv()).toMatchObject({
      status: 'invalid',
      issue: 'Environment exceeds the MCP inspection field limits.'
    })
    expect(inspectEnv()?.env).toBeUndefined()
  })

  // The two divergences the port never closed, pinned so a fix flips them red
  // rather than drifting back. Both are confined to a server's `env`, which
  // McpConfigFileRow only prints.
  describe('known port divergences from the deleted twin', () => {
    it('keeps an __proto__ env key the twin silently dropped, without polluting a prototype', () => {
      const server = inspect(
        '{"mcpServers":{"a":{"command":"node","env":{"__proto__":"kept","OK":"v"}}}}'
      ).servers[0]

      // The twin's `masked[key] = value` hit Object.prototype's __proto__ setter.
      expect(server?.env).toEqual({ ['__proto__']: 'kept', OK: 'v' })
      expect(Object.getPrototypeOf(server?.env)).toBe(Object.prototype)
      expect(({} as { kept?: unknown }).kept).toBeUndefined()
    })

    it('prints a float env value one ULP off (serde_json vendored without float_roundtrip)', () => {
      // The hazard is in the FILE TEXT, not the double: a literal whose nearest
      // double needs the slow path. V8 rounds it correctly, serde's fast path
      // lands one ULP away, and both then print the shortest form of what they got.
      const literal = '2.2250738585072011e-308'
      const twinAnswer = String((JSON.parse(`{"F":${literal}}`) as { F: number }).F)
      const server = inspect(`{"mcpServers":{"a":{"command":"node","env":{"F":${literal}}}}}`)
        .servers[0]

      expect(twinAnswer).toBe('2.225073858507201e-308')
      expect(server?.env?.F).toBe('2.2250738585072014e-308')
    })
  })
})
