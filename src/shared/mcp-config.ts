// MCP config candidates, types, and directory discovery. `inspectMcpConfigContent`
// is now the Rust `mcp` core (rust/crates/orca-config/src/mcp.rs); the renderer
// reaches it through src/renderer/src/lib/git-wasm/mcp-config-content-inspection.ts.
export { maskMcpEnv } from './mcp-server-inspection'

export type McpConfigFormat = 'workspace' | 'cursor' | 'claude'

export type McpConfigCandidate = {
  format: McpConfigFormat
  label: string
  relativePath: string
  serversPath: string[]
}

export type McpConfigDirectoryEntry = {
  name: string
  isDirectory: boolean
}

export type McpServerTransport = 'stdio' | 'http' | 'unknown'
export type McpServerStatus = 'enabled' | 'disabled' | 'invalid'

export type McpServerSummary = {
  name: string
  transport: McpServerTransport
  status: McpServerStatus
  command?: string
  url?: string
  env?: Record<string, string>
  issue?: string
}

export type McpConfigInspection = {
  candidate: McpConfigCandidate
  exists: boolean
  status: 'missing' | 'valid' | 'invalid'
  servers: McpServerSummary[]
  error?: string
}

export const MCP_CONFIG_CANDIDATES: McpConfigCandidate[] = [
  {
    format: 'workspace',
    label: 'Workspace',
    relativePath: '.mcp.json',
    serversPath: ['mcpServers']
  },
  {
    format: 'cursor',
    label: 'Cursor',
    relativePath: '.cursor/mcp.json',
    serversPath: ['mcpServers']
  },
  {
    format: 'claude',
    label: 'Claude',
    relativePath: '.claude.json',
    serversPath: ['mcpServers']
  },
  {
    format: 'claude',
    label: 'Claude workspace',
    relativePath: '.claude/mcp.json',
    serversPath: ['mcpServers']
  }
]

export const MCP_STARTER_CONFIG = `{
  "mcpServers": {}
}
`

export function getMcpConfigParentDirs(
  candidates: readonly McpConfigCandidate[] = MCP_CONFIG_CANDIDATES
): string[] {
  return Array.from(
    new Set(
      candidates
        .map((candidate) => getRelativeParentDir(candidate.relativePath))
        .filter((parentDir) => parentDir !== '')
    )
  )
}

export function getMcpConfigCandidateParentDir(candidate: McpConfigCandidate): string {
  return getRelativeParentDir(candidate.relativePath)
}

export function selectExistingMcpConfigCandidates(
  entriesByRelativeDir: ReadonlyMap<string, readonly McpConfigDirectoryEntry[]>,
  candidates: readonly McpConfigCandidate[] = MCP_CONFIG_CANDIDATES
): McpConfigCandidate[] {
  return candidates.filter((candidate) => {
    const parentDir = getRelativeParentDir(candidate.relativePath)
    const basename = getRelativeBasename(candidate.relativePath)
    const entries = entriesByRelativeDir.get(parentDir) ?? []
    return entries.some((entry) => entry.name === basename && !entry.isDirectory)
  })
}

export function canInspectLocalMcpConfigRoot(rootPath: string, isWindowsHost: boolean): boolean {
  if (isWindowsHost) {
    return true
  }
  return !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(rootPath)
}

function getRelativeParentDir(relativePath: string): string {
  const normalizedPath = relativePath.replace(/\\/g, '/')
  const separatorIndex = normalizedPath.lastIndexOf('/')
  return separatorIndex === -1 ? '' : normalizedPath.slice(0, separatorIndex)
}

function getRelativeBasename(relativePath: string): string {
  const normalizedPath = relativePath.replace(/\\/g, '/')
  const separatorIndex = normalizedPath.lastIndexOf('/')
  return separatorIndex === -1 ? normalizedPath : normalizedPath.slice(separatorIndex + 1)
}
