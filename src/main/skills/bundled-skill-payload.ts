import { createHash } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { SkillBundleFileIdentity, SkillCurrentBundleEntry } from '../../shared/skill-freshness'
import { skillBundleResourceRoot, type SkillBundleArtifacts } from './skill-bundle-artifacts'
import { SKILL_PACKAGE_OBSERVATION_LIMITS } from './skill-package-identity'

export type BundledSkillPayloadFile = {
  /** Manifest path: '/' separated on every host, converted at the filesystem boundary. */
  path: string
  bytes: Buffer
  executable: boolean
}

export type BundledSkillPayloadFailure =
  | 'unknown-skill'
  | 'unsafe-manifest-path'
  | 'file-missing'
  | 'size-mismatch'
  | 'digest-mismatch'
  | 'extra-file'
  | 'size-limit'
  | 'read-failed'

export type BundledSkillPayload =
  | { verified: true; entry: SkillCurrentBundleEntry; files: BundledSkillPayloadFile[] }
  | { verified: false; failure: BundledSkillPayloadFailure; detail: string }

export function bundledSkillPackagesRoot(resourceRoot = skillBundleResourceRoot()): string {
  return join(resourceRoot, 'skills', 'packages')
}

class PayloadRejection extends Error {
  constructor(
    readonly failure: BundledSkillPayloadFailure,
    detail: string
  ) {
    super(detail)
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// Why: ':' is a stream separator on Windows and '\' a separator there too, so a
// manifest path carrying either would address something other than a plain file.
const UNSAFE_PATH_SEGMENT = /^$|^\.\.?$|[\\:]/
const NUL = '\u0000'

function nativeRelativeSkillPath(manifestPath: string): string {
  const segments = manifestPath.split('/')
  if (segments.some((segment) => UNSAFE_PATH_SEGMENT.test(segment) || segment.includes(NUL))) {
    throw new PayloadRejection('unsafe-manifest-path', manifestPath)
  }
  return segments.join(sep)
}

async function collectPackageFiles(packageRoot: string): Promise<Set<string>> {
  const found = new Set<string>()
  let entryCount = 0

  async function visit(prefix: string, depth: number): Promise<void> {
    if (depth > SKILL_PACKAGE_OBSERVATION_LIMITS.maximumDepth) {
      throw new PayloadRejection('extra-file', `${prefix} exceeds the package depth limit`)
    }
    for (const entry of await readdir(join(packageRoot, prefix), { withFileTypes: true })) {
      entryCount += 1
      if (entryCount > SKILL_PACKAGE_OBSERVATION_LIMITS.maximumEntries) {
        throw new PayloadRejection('extra-file', 'package exceeds the entry limit')
      }
      const relativePath = join(prefix, entry.name)
      if (entry.isDirectory()) {
        await visit(relativePath, depth + 1)
        continue
      }
      // Why: a link or device node in the payload would install bytes nothing
      // hashed. Only regular files are shipped content.
      if (!entry.isFile()) {
        throw new PayloadRejection('extra-file', `${relativePath} is not a regular file`)
      }
      found.add(relativePath)
    }
  }

  await visit('', 0)
  return found
}

async function readVerifiedFile(
  absolutePath: string,
  expected: SkillBundleFileIdentity
): Promise<Buffer> {
  const handle = await open(absolutePath, 'r').catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'ENOENT'
      ? new PayloadRejection('file-missing', expected.path)
      : new PayloadRejection('read-failed', `${expected.path}: ${error.code ?? error.message}`)
  })
  try {
    const stats = await handle.stat()
    if (stats.size !== expected.size) {
      throw new PayloadRejection(
        'size-mismatch',
        `${expected.path}: ${stats.size} bytes, manifest says ${expected.size}`
      )
    }
    const bytes = Buffer.alloc(stats.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) {
        throw new PayloadRejection('read-failed', `${expected.path} ended early`)
      }
      offset += bytesRead
    }
    if (sha256(bytes) !== expected.exactSha256) {
      throw new PayloadRejection('digest-mismatch', expected.path)
    }
    return bytes
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Read one shipped skill package, verified byte-for-byte against the manifest.
 *
 * Nothing downstream re-checks these bytes before they land in the user's agent
 * homes, so a corrupt or tampered bundle has to fail here or not at all: every
 * manifest file must be present at its exact size and sha256, and the package
 * may hold nothing the manifest does not describe.
 */
export async function readBundledSkillPayload(args: {
  name: string
  artifacts: SkillBundleArtifacts
  resourceRoot?: string
}): Promise<BundledSkillPayload> {
  const entry = args.artifacts.manifest.skills.find((skill) => skill.name === args.name)
  if (!entry) {
    return { verified: false, failure: 'unknown-skill', detail: args.name }
  }
  const packageRoot = join(bundledSkillPackagesRoot(args.resourceRoot), entry.name)
  try {
    const declaredBytes = entry.files.reduce((total, file) => total + file.size, 0)
    if (
      declaredBytes > SKILL_PACKAGE_OBSERVATION_LIMITS.maximumTotalBytes ||
      entry.files.some(
        (file) => file.size > SKILL_PACKAGE_OBSERVATION_LIMITS.maximumSingleFileBytes
      )
    ) {
      throw new PayloadRejection('size-limit', `${entry.name} exceeds the package byte ceiling`)
    }
    const expectedByNativePath = new Map(
      entry.files.map((file) => [nativeRelativeSkillPath(file.path), file] as const)
    )
    for (const relativePath of await collectPackageFiles(packageRoot)) {
      if (!expectedByNativePath.has(relativePath)) {
        throw new PayloadRejection('extra-file', relativePath)
      }
    }
    const files: BundledSkillPayloadFile[] = []
    for (const [relativePath, file] of expectedByNativePath) {
      files.push({
        path: file.path,
        bytes: await readVerifiedFile(join(packageRoot, relativePath), file),
        executable: file.executable
      })
    }
    return { verified: true, entry, files }
  } catch (error) {
    if (error instanceof PayloadRejection) {
      return { verified: false, failure: error.failure, detail: error.message }
    }
    const code = (error as NodeJS.ErrnoException).code
    return {
      verified: false,
      // A missing package directory reads as ENOENT from the walk, not from a file open.
      failure: code === 'ENOENT' ? 'file-missing' : 'read-failed',
      detail: `${entry.name}: ${code ?? (error as Error).message}`
    }
  }
}
