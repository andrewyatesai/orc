import { describe, expect, it } from 'vitest'
import { isHiddenNonSkillEntry } from './discovery'
import type { SkillScanRoot } from './skill-discovery-sources'
import { buildWslSkillDiscoveryCommand, parseWslSkillDiscoveryOutput } from './skill-discovery-wsl'

const homeRoot: SkillScanRoot = {
  id: 'home-codex',
  label: 'Codex home',
  path: '/home/alice/.codex/skills',
  sourceKind: 'home',
  providers: ['codex'],
  owner: 'codex'
}
const repoRoot: SkillScanRoot = {
  id: 'repo-agents',
  label: 'Repo project .agents',
  path: '/work/project/.agents/skills',
  sourceKind: 'repo',
  providers: ['agent-skills'],
  owner: null
}

function record(...fields: string[]): string {
  return `${fields.join('\0')}\0`
}

function decodeScanScript(roots: readonly SkillScanRoot[]): string {
  const encoded = /printf %s '([^']+)'/.exec(buildWslSkillDiscoveryCommand(roots))?.[1]
  expect(encoded).toBeTruthy()
  return Buffer.from(encoded!, 'base64').toString('utf8')
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
}

// Reads the prune clause back out of the generated script and evaluates it the way
// `find` would, so the shell rule can be compared against the native predicate.
function scriptPrunesEntry(script: string, name: string): boolean {
  const clause = /\\\((.+?)\\\) -prune/.exec(script)?.[1]
  expect(clause).toBeTruthy()
  const tests = [...clause!.matchAll(/(!\s+)?-name '([^']*)'/g)]
  expect(tests.length).toBeGreaterThan(0)
  return tests.every(([, negated, glob]) => globToRegExp(glob).test(name) !== Boolean(negated))
}

describe('WSL skill discovery', () => {
  it('parses distro-native metadata and deduplicates canonical skill paths', () => {
    const markdown = Buffer.from(
      '---\nname: Review\ndescription: Review this change\n---\n',
      'utf8'
    ).toString('base64')
    const output = [
      record('R', '0', '1'),
      record('R', '1', '0'),
      record(
        'S',
        '0',
        '/home/alice/.codex/skills/.system/review/SKILL.md',
        '/opt/orca/review/SKILL.md',
        '1700000000',
        '7',
        markdown
      ),
      record(
        'S',
        '1',
        '/work/project/.agents/skills/review/SKILL.md',
        '/opt/orca/review/SKILL.md',
        '1700000001',
        '9',
        markdown
      )
    ].join('')

    const result = parseWslSkillDiscoveryOutput(output, [homeRoot, repoRoot], 42)

    expect(result.scannedAt).toBe(42)
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: 'Review',
        description: 'Review this change',
        sourceKind: 'bundled',
        rootPath: homeRoot.path,
        skillFilePath: '/home/alice/.codex/skills/.system/review/SKILL.md',
        fileCount: 7,
        updatedAt: 1_700_000_000_000
      })
    ])
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'home-codex', exists: true }),
        expect.objectContaining({ id: 'repo-agents', exists: false, skippedReason: 'missing' })
      ])
    )
  })

  it('builds a distro-side scan for enumeration, reads, and canonical identity', () => {
    const script = decodeScanScript([{ ...repoRoot, path: "/work/alice's project/.agents/skills" }])

    expect(script).toContain('find -L "$root_path"')
    expect(script).toContain('realpath -- "$skill_file"')
    expect(script).toContain('head -c 262144 -- "$skill_file"')
    expect(script).toContain(`'/work/alice'\\''s project/.agents/skills'`)
  })

  it('prunes hidden install scratch directories without pruning the root or `.system`', () => {
    const script = decodeScanScript([repoRoot])

    expect(script).toContain(
      `find -L "$root_path" -mindepth 1 -maxdepth "$max_depth" \\( -name '.*' ! -name '.system' \\) -prune -o -type f -name 'SKILL.md' -print0`
    )
  })

  it('keeps the distro-side prune in agreement with the native hidden-entry rule', () => {
    const script = decodeScanScript([repoRoot])

    // A drifting shell form (or predicate) makes one of these disagree.
    for (const name of [
      '.orchestration.orca-staging-0123456789ab',
      '.orchestration.orca-replaced-0123456789ab',
      '.system',
      '.systematic',
      '..deep',
      '.git',
      'orchestration',
      'SKILL.md'
    ]) {
      expect(`${name}:${scriptPrunesEntry(script, name)}`).toBe(
        `${name}:${isHiddenNonSkillEntry(name)}`
      )
    }
  })

  it('rejects malformed host responses instead of reporting an empty scan', () => {
    expect(() => parseWslSkillDiscoveryOutput(record('S', '9'), [homeRoot])).toThrow(
      'unknown source'
    )
  })
})
