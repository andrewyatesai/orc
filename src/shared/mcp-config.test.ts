// `inspectMcpConfigContent` moved to the Rust core; its cases now live in
// src/renderer/src/lib/git-wasm/mcp-config-content-inspection.test.ts.
import { describe, expect, it } from 'vitest'
import {
  canInspectLocalMcpConfigRoot,
  getMcpConfigCandidateParentDir,
  getMcpConfigParentDirs,
  maskMcpEnv,
  MCP_CONFIG_CANDIDATES,
  selectExistingMcpConfigCandidates
} from './mcp-config'

describe('mcp-config', () => {
  it('masks env values that look sensitive by key or value', () => {
    expect(
      maskMcpEnv({
        NORMAL: 'visible',
        PASSWORD: 'hunter2',
        MAYBE: 'sk-abc123456789xyz'
      })
    ).toEqual({
      NORMAL: 'visible',
      PASSWORD: '••••••••',
      MAYBE: '••••••••'
    })
  })

  it('plans directory discovery before reading candidate files', () => {
    expect(getMcpConfigParentDirs()).toEqual(['.cursor', '.claude'])
    expect(
      MCP_CONFIG_CANDIDATES.map((candidate) => getMcpConfigCandidateParentDir(candidate))
    ).toEqual(['', '.cursor', '', '.claude'])

    const entriesByRelativeDir = new Map([
      [
        '',
        [
          { name: '.mcp.json', isDirectory: false },
          { name: '.cursor', isDirectory: true },
          { name: '.claude', isDirectory: false }
        ]
      ],
      ['.cursor', [{ name: 'mcp.json', isDirectory: false }]]
    ])

    expect(
      selectExistingMcpConfigCandidates(entriesByRelativeDir).map((entry) => entry.label)
    ).toEqual(['Workspace', 'Cursor'])
  })

  it('rejects Windows-only local roots on non-Windows hosts', () => {
    expect(canInspectLocalMcpConfigRoot('C:\\repo', false)).toBe(false)
    expect(canInspectLocalMcpConfigRoot('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', false)).toBe(
      false
    )
    expect(canInspectLocalMcpConfigRoot('//wsl.localhost/Ubuntu/home/me/repo', false)).toBe(false)
    expect(canInspectLocalMcpConfigRoot('/userhome/me/repo', false)).toBe(true)
    expect(canInspectLocalMcpConfigRoot('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', true)).toBe(
      true
    )
    expect(canInspectLocalMcpConfigRoot('//wsl.localhost/Ubuntu/home/me/repo', true)).toBe(true)
  })
})
