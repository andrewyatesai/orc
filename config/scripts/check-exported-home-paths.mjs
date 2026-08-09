// Absolute home paths must not reach the public tree. The publication engine
// already refuses to export `/Users/<name>`, on the reasoning that it cannot
// tell a developer's real home directory from a fictional one and should not
// try — the pattern earns its keep by being unconditional. That refusal fires at
// the release wall, though, long after the commit that caused it, and it has
// blocked a promote three times on example paths in test fixtures alone.
//
// So the same rule runs here, where the author can see it. Source of truth is
// baseline/forbidden-content.txt in the publication engine; this is the one rule
// from it that source code trips in practice.
//
// Writing a POSIX path in a fixture is fine. Write it under /home, or name a
// directory that is not a home directory at all.
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const HOME_PATH_PATTERN = '/Users/[A-Za-z]'

// Never exported, so a home path in them cannot leak: the engine's path-deny
// list drops these before any guard runs.
const PATH_DENIED = [':!docs', ':!publish', ':!.github']

export async function findHomePaths(root = process.cwd()) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      // --untracked so a file flags before it is ever staged; it still honours
      // .gitignore, so build output and node_modules stay out of the scan.
      ['grep', '-InE', '--untracked', HOME_PATH_PATTERN, '--', '.', ...PATH_DENIED],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 }
    )
    return stdout.split('\n').filter(Boolean)
  } catch (error) {
    // git grep exits 1 with no output when nothing matches, which is success.
    if (error.code === 1 && !error.stdout) {
      return []
    }
    throw error
  }
}

export async function main(root = process.cwd()) {
  const hits = await findHomePaths(root)
  if (hits.length === 0) {
    console.log('[exported-home-paths] ok — no absolute home paths in exported source.')
    return 0
  }

  console.error('Absolute home paths must not reach the public tree.')
  console.error('The publication engine refuses to export /Users/<name>, real or fictional.')
  console.error('Use /home/<name>, or a directory that is not a home directory.')
  console.error('')
  for (const hit of hits) {
    console.error(hit.length > 200 ? `${hit.slice(0, 200)}…` : hit)
  }
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
