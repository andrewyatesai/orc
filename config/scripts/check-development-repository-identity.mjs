import { spawnSync } from 'node:child_process'

import { DEFAULT_RELEASE_REPOSITORY } from './release-repository.mjs'

const boundary = '([^A-Za-z0-9_-]|$)'
const retiredRepositoryNames = ['orc', 'aterm']
const publicOwner = DEFAULT_RELEASE_REPOSITORY.split('/')[0]

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

function ownerOf(remoteUrl) {
  const segments = remoteUrl.trim().replace(/\.git$/, '').split(/[:/]/).filter(Boolean)
  return segments.length >= 2 ? segments.at(-2) : ''
}

// Why derived instead of written down: the retired names only ever existed under
// the development owner, and spelling that owner out here would ship a private
// org name into every public snapshot of this repo.
function developmentOwner() {
  const configured = process.env.ORCA_DEVELOPMENT_OWNER?.trim()
  if (configured) {
    return configured
  }
  const remotes = git(['remote'])
  if (remotes.status !== 0) {
    return ''
  }
  for (const remote of remotes.stdout.trim().split('\n').filter(Boolean)) {
    const url = git(['remote', 'get-url', remote])
    if (url.status !== 0) {
      continue
    }
    const owner = ownerOf(url.stdout)
    if (owner && owner.toLowerCase() !== publicOwner.toLowerCase()) {
      return owner
    }
  }
  return ''
}

const owner = developmentOwner()
if (!owner) {
  console.log(
    '[repository-identity] skipped — no development remote, so there are no retired names to scope.'
  )
  process.exit(0)
}

const retiredRepositories = retiredRepositoryNames.map((name) => `${owner}/${name}`)

let foundRetiredReference = false
for (const repository of retiredRepositories) {
  const result = git(['grep', '-n', '-I', '-E', `${repository}${boundary}`, '--', '.'])
  if (result.status === 1) {
    continue
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `git grep failed while checking ${repository}`)
  }
  for (const line of result.stdout.trimEnd().split('\n')) {
    foundRetiredReference = true
    console.error(`[repository-identity] ${line}: retired reference ${repository}`)
  }
}

if (foundRetiredReference) {
  process.exitCode = 1
} else {
  console.log(
    '[repository-identity] ok — development and public dependency repository names are canonical.'
  )
}
