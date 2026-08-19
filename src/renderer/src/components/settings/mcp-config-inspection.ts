import {
  getMcpConfigCandidateParentDir,
  getMcpConfigParentDirs,
  MCP_CONFIG_CANDIDATES,
  selectExistingMcpConfigCandidates,
  type McpConfigDirectoryEntry,
  type McpConfigInspection
} from '../../../../shared/mcp-config'
import { inspectMcpConfigContent } from '../../lib/git-wasm/mcp-config-content-inspection'
import { joinPath } from '../../lib/path'
import { extractIpcErrorMessage } from '../../lib/ipc-error'
import type { LoadedMcpConfigInspection } from './McpConfigFileRow'

/** The Rust inspection core is not loaded, so a config file that EXISTS has no
 *  honest summary — a guessed row would claim a size/parse/bounds verdict the
 *  core never gave. McpConfigSection turns this into its banner and re-runs the
 *  load on the wasm availability edge. */
export class McpConfigInspectionUnavailableError extends Error {
  constructor() {
    super('MCP config inspection core is not ready.')
    this.name = 'McpConfigInspectionUnavailableError'
  }
}

function isMissingFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|no such file|not found/i.test(message)
}

export async function loadMcpConfigInspections(
  targetRootPath: string,
  connectionId: string | undefined
): Promise<LoadedMcpConfigInspection[]> {
  const entriesByRelativeDir = new Map<string, readonly McpConfigDirectoryEntry[]>()
  const rootEntries = await window.api.fs.readDir({ dirPath: targetRootPath, connectionId })
  entriesByRelativeDir.set('', rootEntries)

  const rootDirectoryNames = new Set(
    rootEntries.filter((entry) => entry.isDirectory).map((entry) => entry.name)
  )
  const unreadableParentDirMessages = new Map<string, string>()
  await Promise.all(
    getMcpConfigParentDirs().map(async (relativeDir) => {
      if (!rootDirectoryNames.has(relativeDir)) {
        return
      }
      try {
        const entries = await window.api.fs.readDir({
          dirPath: joinPath(targetRootPath, relativeDir),
          connectionId
        })
        entriesByRelativeDir.set(relativeDir, entries)
      } catch (error) {
        unreadableParentDirMessages.set(
          relativeDir,
          extractIpcErrorMessage(error, `Unable to inspect ${relativeDir}.`)
        )
      }
    })
  )

  const existingRelativePaths = new Set(
    selectExistingMcpConfigCandidates(entriesByRelativeDir).map(
      (candidate) => candidate.relativePath
    )
  )

  return Promise.all(
    MCP_CONFIG_CANDIDATES.map(async (candidate): Promise<LoadedMcpConfigInspection> => {
      const absolutePath = joinPath(targetRootPath, candidate.relativePath)
      const parentDirReadError = unreadableParentDirMessages.get(
        getMcpConfigCandidateParentDir(candidate)
      )
      if (parentDirReadError) {
        return {
          ...inspectMcpConfigContent(candidate, null),
          exists: false,
          status: 'invalid',
          absolutePath,
          readError: parentDirReadError
        }
      }

      if (!existingRelativePaths.has(candidate.relativePath)) {
        return { ...inspectMcpConfigContent(candidate, null), absolutePath }
      }

      let content: string
      try {
        const result = await window.api.fs.readFile({ filePath: absolutePath, connectionId })
        content = result.isBinary ? '' : result.content
      } catch (error) {
        if (isMissingFileError(error)) {
          return { ...inspectMcpConfigContent(candidate, null), absolutePath }
        }
        return {
          ...inspectMcpConfigContent(candidate, null),
          exists: false,
          status: 'invalid',
          absolutePath,
          readError: extractIpcErrorMessage(error, 'Unable to read config file.')
        }
      }

      // Why outside the read's catch: a not-ready core is not a per-file read
      // error, and reporting it as one would render `exists: false` for a config
      // that is sitting right there.
      let inspection: McpConfigInspection | null
      try {
        inspection = inspectMcpConfigContent(candidate, content)
      } catch (error) {
        // One bad file costs ONE row. The seam throws for a payload the dispatch
        // codec refuses (content holding a lone surrogate) or a core failure
        // envelope, and inside this `Promise.all` that rejected the whole load —
        // a workspace with a healthy `.claude.json` lost all four candidate rows.
        return {
          ...inspectMcpConfigContent(candidate, null),
          exists: true,
          status: 'invalid',
          absolutePath,
          readError: extractIpcErrorMessage(error, 'Unable to inspect this config file.')
        }
      }
      if (!inspection) {
        // Not per-file: the core is unready for EVERY candidate, so the section's
        // banner is the honest answer and this one propagates.
        throw new McpConfigInspectionUnavailableError()
      }
      return { ...inspection, absolutePath }
    })
  )
}
