import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const guardScript = join(projectDir, '.github/scripts/check-root-directory-entries.sh')
// Why: the guard needs `declare -A`, which macOS's stock bash 3.2 rejects outright.
const HAS_ASSOCIATIVE_ARRAY_BASH =
  spawnSync('bash', ['-c', 'declare -A probe'], { encoding: 'utf8' }).status === 0
// Why: the fork runs no hosted CI, so pr.yml is dropped — gate the wiring assertion on it.
const HAS_CI_PR_WORKFLOW = existsSync(join(projectDir, '.github/workflows/pr.yml'))
const tempDirs = []

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-root-directory-guard-'))
  tempDirs.push(root)
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'root-directory-guard-test@example.com'])
  git(root, ['config', 'user.name', 'Root Directory Guard Test'])
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'base.txt'), 'base\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', 'base'])
  return { root, base: git(root, ['rev-parse', 'HEAD']) }
}

function commitFiles(root, files) {
  for (const [relativePath, contents] of files) {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', 'head'])
  return git(root, ['rev-parse', 'HEAD'])
}

function runGuard({ root, base, head }) {
  return spawnSync('bash', [guardScript, base, head], {
    cwd: root,
    encoding: 'utf8'
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('root directory guard', () => {
  it.skipIf(!HAS_ASSOCIATIVE_ARRAY_BASH)(
    'allows additions inside an existing top-level directory',
    () => {
      const fixture = makeFixture()
      const head = commitFiles(fixture.root, [['config/new.txt', 'nested\n']])

      const result = runGuard({ ...fixture, head })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('no new root-level files or folders')
    }
  )

  it.skipIf(!HAS_ASSOCIATIVE_ARRAY_BASH)(
    'rejects a new root-level file with the landing-page message',
    () => {
      const fixture = makeFixture()
      const head = commitFiles(fixture.root, [['new-root.md', 'too prominent\n']])

      const result = runGuard({ ...fixture, head })
      const output = `${result.stdout}\n${result.stderr}`

      expect(result.status).toBe(1)
      expect(output).toContain('bloat the GitHub landing page')
      expect(output).toContain('new-root.md')
    }
  )

  it.skipIf(!HAS_ASSOCIATIVE_ARRAY_BASH)('rejects a new top-level directory', () => {
    const fixture = makeFixture()
    const head = commitFiles(fixture.root, [['new-folder/file.txt', 'too prominent\n']])

    const result = runGuard({ ...fixture, head })
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status).toBe(1)
    expect(output).toContain('new-folder')
  })

  it.skipIf(!HAS_CI_PR_WORKFLOW)('is wired into the PR verify gate', () => {
    const workflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
    const guardJob = workflow.jobs.root_directory_guard
    const guardStep = guardJob.steps.find(
      (step) => step.name === 'Reject new root-level files and folders'
    )

    expect(guardJob.name).toBe('root directory guard')
    expect(guardJob.steps[0].with['fetch-depth']).toBe(0)
    expect(guardStep.run).toContain('.github/scripts/check-root-directory-entries.sh')
    expect(workflow.jobs.verify.needs).toContain('root_directory_guard')
  })
})
