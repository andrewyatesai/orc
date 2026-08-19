import { parseWslUncPath } from './wsl-unc-paths'

export function normalizeAiVaultResumeFilePath(
  filePath: string | undefined,
  platform: NodeJS.Platform
): string | undefined {
  if (!filePath || platform !== 'linux') {
    return filePath
  }
  return parseWslUncPath(filePath)?.linuxPath ?? filePath
}
