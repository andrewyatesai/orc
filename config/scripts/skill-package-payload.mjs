import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Why: the manifest addresses files with '/' on every host; the payload lives on
// the host filesystem, so the two vocabularies must be converted, never assumed.
function nativeRelativePath(manifestPath) {
  return manifestPath.split('/').join(path.sep)
}

function expectedPayloadFiles(manifest) {
  const expected = new Map()
  for (const skill of manifest.skills) {
    for (const file of skill.files) {
      expected.set(path.join(skill.name, nativeRelativePath(file.path)), file)
    }
  }
  return expected
}

function matchesManifestEntry(bytes, entry) {
  if (bytes.length !== entry.size) {
    return false
  }
  return createHash('sha256').update(bytes).digest('hex') === entry.exactSha256
}

async function collectPayloadFiles(packagesRoot) {
  const found = new Set()

  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = path.join(prefix, entry.name)
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relativePath)
        continue
      }
      // Why: symlinks and special files are not shipped bytes. Leaving them out
      // reports the manifest path as missing rather than following the link.
      if (entry.isFile()) {
        found.add(relativePath)
      }
    }
  }

  // A never-generated payload is every file stale, not a crash.
  const missingRoot = await access(packagesRoot).then(
    () => false,
    () => true
  )
  if (missingRoot) {
    return found
  }
  await visit(packagesRoot, '')
  return found
}

// Why: emitting from scratch is what prunes a removed skill's directory —
// nothing else knows the package used to exist.
async function writeSkillPackagePayload({ skillsRoot, packagesRoot, manifest }) {
  await rm(packagesRoot, { recursive: true, force: true })
  for (const [relativePath, entry] of expectedPayloadFiles(manifest)) {
    const bytes = await readFile(path.join(skillsRoot, relativePath))
    // Why: the manifest hashed these bytes before this copy ran. Re-hashing
    // fails a concurrent edit loudly instead of shipping an undescribed byte.
    if (!matchesManifestEntry(bytes, entry)) {
      throw new Error(`Skill bytes changed while emitting the payload: ${relativePath}`)
    }
    const destination = path.join(packagesRoot, relativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
  }
}

// Why: one message, shared with the JSON artifact check — a stale payload and a
// stale manifest have the same cause and the same remedy.
async function verifySkillPackagePayload({ packagesRoot, manifest, repoRoot = packagesRoot }) {
  const expected = expectedPayloadFiles(manifest)
  const present = await collectPayloadFiles(packagesRoot)
  const stale = []
  for (const [relativePath, entry] of expected) {
    if (!present.has(relativePath)) {
      stale.push(relativePath)
      continue
    }
    if (!matchesManifestEntry(await readFile(path.join(packagesRoot, relativePath)), entry)) {
      stale.push(relativePath)
    }
  }
  // An orphan file is as stale as a missing one: it would ship with no manifest entry.
  for (const relativePath of present) {
    if (!expected.has(relativePath)) {
      stale.push(relativePath)
    }
  }
  if (stale.length === 0) {
    return
  }
  const base = path.relative(repoRoot, packagesRoot)
  throw new Error(
    `Generated skill artifacts are stale:\n${stale
      .sort()
      .map((relativePath) => path.join(base, relativePath))
      .join('\n')}\nRun pnpm generate:skill-bundle-manifest.`
  )
}

export { expectedPayloadFiles, verifySkillPackagePayload, writeSkillPackagePayload }
