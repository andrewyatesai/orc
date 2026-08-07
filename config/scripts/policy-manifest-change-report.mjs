import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Policy-manifest co-occurrence report — A REVIEW AID, NOT A GATE.
//
// WHAT IT DOES: for one change set (staged, a commit range, or an explicit file
// list) it prints which policy/baseline/exemption manifests were modified and
// which source files were modified alongside them, and says a human should
// confirm the policy edit is legitimate.
//
// WHAT IT DOES NOT DO — read this before citing it as protection:
//   * It detects CO-OCCURRENCE, never intent. It cannot tell a legitimate
//     policy edit from one written to excuse the source change in the same
//     commit. Nothing static can: the manifest IS the policy.
//   * An author who wants to avoid appearing here only has to split the work
//     across two commits, or land the manifest edit first. That is trivial and
//     this tool has no answer to it.
//   * It ALWAYS EXITS 0, including when it finds co-occurrence and when git
//     itself fails. It is not wired into `pnpm lint` and must not be. If it
//     ever gains an exit code, everything above becomes a false guarantee.
//
// It is therefore a way to make an in-change policy edit LOUD, not a control.
//
// USAGE (not wired to any npm script; run it by hand, or from a pre-push hook or
// a review step where a human reads the output):
//   node config/scripts/policy-manifest-change-report.mjs                  # staged
//   node config/scripts/policy-manifest-change-report.mjs --range main..HEAD
//   node config/scripts/policy-manifest-change-report.mjs --files a.ts b.txt
//   node config/scripts/policy-manifest-change-report.mjs --list-policy-files

// A bare extension (`'.json'`) is a suffix test in someone's code, not a path.
const DATA_FILE_PATTERN = /[^/.]\.(?:jsonc?|txt|ya?ml|toml|ini)$/
const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|rs|swift|kt|java|go|py|css|scss|html)$/
// Build/vendor output that scripts reference but nobody reviews; excluded as noise.
const NON_REVIEWED_SEGMENTS = new Set(['node_modules', 'target', 'out', 'dist', 'build', '.git'])

const SELF_PATH = 'config/scripts/policy-manifest-change-report.mjs'

// The derivation below finds manifests that a lint-chain script names in a string
// literal. Configs read implicitly (oxlint's default rc) have no literal to find,
// so they are listed by hand here.
//
// THIS LIST IS ITSELF A POLICY MANIFEST WITH EXACTLY THE WEAKNESS THIS TOOL
// REPORTS ON: deleting a line from it hides that file from every future report,
// in the same commit that edits the file. That is not fixable here — it is why
// SELF_PATH is treated as a policy file too, so at least the edit shows up.
export const EXTRA_POLICY_FILES = ['.oxlintrc.json', SELF_PATH]

function isNonReviewedPath(relativePath) {
  return relativePath.split('/').some((segment) => NON_REVIEWED_SEGMENTS.has(segment))
}

/** Script files reachable from `scripts.lint`, following `pnpm run <name>` hops. */
export function collectLintChainScripts(packageScripts, entry = 'lint') {
  const visited = new Set()
  const scripts = []
  const configArgs = []
  const queue = [entry]
  while (queue.length > 0) {
    const name = queue.shift()
    if (visited.has(name)) {
      continue
    }
    visited.add(name)
    const command = packageScripts?.[name]
    if (typeof command !== 'string') {
      continue
    }
    for (const argMatch of command.matchAll(/--config\s+(\S+)/g)) {
      configArgs.push(argMatch[1])
    }
    for (const segment of command.split(/&&|\|\||;/)) {
      const runMatch = /^\s*pnpm\s+(?:run\s+)?([\w:-]+)/.exec(segment)
      if (runMatch) {
        queue.push(runMatch[1])
        continue
      }
      const nodeMatch = /\bnode\s+(\S+\.(?:mjs|cjs|js))/.exec(segment)
      if (nodeMatch) {
        scripts.push(nodeMatch[1])
      }
    }
  }
  return { scripts, configArgs }
}

/** Repo-relative data-file paths named by string literals in one script's text. */
export function extractDataFileLiterals(sourceText) {
  const found = new Set()
  for (const match of sourceText.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)) {
    const literal = match[1] ?? match[2] ?? ''
    if (DATA_FILE_PATTERN.test(literal) && !/[\s*]/.test(literal)) {
      found.add(literal)
    }
  }
  // `path.join('config', 'reliability-gates.jsonc')` never appears as one literal.
  for (const match of sourceText.matchAll(/path\.join\(([^)]*)\)/g)) {
    const args = match[1].split(',')
    const literals = [...match[1].matchAll(/'([^'\n]*)'/g)].map((part) => part[1])
    if (literals.length !== args.length) {
      continue // a non-literal argument makes the joined path unknowable
    }
    const joined = literals.join('/')
    if (DATA_FILE_PATTERN.test(joined) && !/[\s*]/.test(joined)) {
      found.add(joined)
    }
  }
  return [...found]
}

function relativeLocalImports(scriptPath, sourceText) {
  const imports = []
  for (const match of sourceText.matchAll(/from\s*'(\.[^'\n]+\.(?:mjs|cjs|js))'/g)) {
    imports.push(path.posix.join(path.posix.dirname(scriptPath), match[1]))
  }
  return imports
}

/**
 * Policy/manifest files this repo's lint chain reads, each with the script that
 * named it. Derived by reading package.json and the scripts themselves, so a new
 * baseline shows up without editing this file — except for EXTRA_POLICY_FILES.
 */
export function discoverPolicyFiles(root) {
  const packageJsonPath = path.join(root, 'package.json')
  let packageScripts = {}
  if (fs.existsSync(packageJsonPath)) {
    packageScripts = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).scripts ?? {}
  }
  const { scripts, configArgs } = collectLintChainScripts(packageScripts)
  const sources = new Map()
  const record = (candidate, referencedBy) => {
    if (!candidate || candidate.startsWith('/') || isNonReviewedPath(candidate)) {
      return
    }
    if (!fs.existsSync(path.join(root, candidate))) {
      return
    }
    const existing = sources.get(candidate)
    if (existing) {
      existing.add(referencedBy)
      return
    }
    sources.set(candidate, new Set([referencedBy]))
  }

  for (const configArg of configArgs) {
    record(configArg, 'package.json scripts.lint')
  }
  const seen = new Set()
  const queue = [...scripts]
  while (queue.length > 0) {
    const scriptPath = queue.shift()
    if (seen.has(scriptPath)) {
      continue
    }
    seen.add(scriptPath)
    const absolute = path.join(root, scriptPath)
    if (!fs.existsSync(absolute)) {
      continue
    }
    const text = fs.readFileSync(absolute, 'utf8')
    for (const literal of extractDataFileLiterals(text)) {
      record(literal, scriptPath)
    }
    queue.push(...relativeLocalImports(scriptPath, text))
  }
  for (const extra of EXTRA_POLICY_FILES) {
    record(extra, `EXTRA_POLICY_FILES in ${SELF_PATH}`)
  }
  return [...sources]
    .map(([file, referencedBy]) => ({ file, referencedBy: [...referencedBy].sort() }))
    .sort((left, right) => left.file.localeCompare(right.file))
}

/** Split a change set into policy manifests, source files, and everything else. */
export function classifyChangedPaths(changedPaths, policyFiles) {
  const byFile = new Map(policyFiles.map((entry) => [entry.file, entry]))
  const policy = []
  const source = []
  const other = []
  for (const changed of [...new Set(changedPaths)].sort()) {
    const known = byFile.get(changed)
    if (known) {
      policy.push(known)
    } else if (SOURCE_FILE_PATTERN.test(changed)) {
      source.push(changed)
    } else {
      other.push(changed)
    }
  }
  return { policy, source, other }
}

function formatList(label, entries) {
  return [`  ${label} (${entries.length}):`, ...entries.map((entry) => `    ${entry}`)]
}

/** The set is derived, so its size is the honest bound on what a null result means. */
export function formatPolicyFileList(policyFiles) {
  return [
    `Policy/manifest files this report knows about (${policyFiles.length}):`,
    ...policyFiles.map((entry) => `  ${entry.file}  [read by ${entry.referencedBy.join(', ')}]`),
    '',
    'Derived from string literals in the `lint` chain, plus a hand-written extras list.',
    'A manifest no lint-chain script names in a literal is absent here and invisible to the report.',
    ''
  ].join('\n')
}

export function formatReport({ scopeLabel, classified, policyFileCount }) {
  const { policy, source, other } = classified
  const lines = [
    'Policy-manifest co-occurrence report (review aid, not a gate — always exits 0)',
    `Change set: ${scopeLabel}`,
    ''
  ]
  if (policy.length === 0) {
    lines.push(
      `  None of the ${policyFileCount} known policy/manifest files changed. (${source.length} source, ${other.length} other file(s) changed.)`
    )
    // Why: a null result here is only as good as the derived set — say so, or it reads as a clean bill of health.
    lines.push('  That set is derived and incomplete; run --list-policy-files to see it.')
    lines.push('')
    return lines.join('\n')
  }
  lines.push(
    ...formatList(
      'Policy/manifest files changed',
      policy.map((entry) => `${entry.file}  [read by ${entry.referencedBy.join(', ')}]`)
    )
  )
  lines.push('')
  lines.push(...formatList('Source files changed alongside them', source))
  if (other.length > 0) {
    lines.push('')
    lines.push(...formatList('Other files changed alongside them', other))
  }
  lines.push('')
  lines.push('  This needs a human to confirm the policy change is legitimate.')
  lines.push(
    '  (Co-occurrence only. Splitting the manifest edit into its own commit evades this report.)'
  )
  lines.push('')
  return lines.join('\n')
}

export function parseArguments(argv) {
  const options = { mode: 'staged', range: undefined, files: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--staged') {
      options.mode = 'staged'
    } else if (arg === '--list-policy-files') {
      options.mode = 'list'
    } else if (arg === '--range') {
      options.mode = 'range'
      options.range = argv[index + 1]
      index += 1
    } else if (arg === '--files') {
      options.mode = 'files'
      options.files = argv.slice(index + 1)
      break
    }
  }
  return options
}

function gitChangedPaths(root, options) {
  const args =
    options.mode === 'range'
      ? ['diff', '--name-only', '-z', options.range]
      : ['diff', '--cached', '--name-only', '-z']
  // Why: capture git's stderr instead of inheriting it, so a bad ref prints one
  // reported line rather than a usage dump that reads like a failing check.
  const output = execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024
  })
  return output.split('\0').filter(Boolean)
}

export function main(argv = [], root = process.cwd(), out = console) {
  const options = parseArguments(argv)
  let changedPaths = []
  let scopeLabel = 'staged changes'
  if (options.mode === 'list') {
    try {
      out.log(formatPolicyFileList(discoverPolicyFiles(root)))
    } catch (error) {
      out.error(`policy-manifest-change-report: could not list policy files: ${error.message}`)
    }
    return 0
  }
  if (options.mode === 'files') {
    changedPaths = options.files
    scopeLabel = `explicit file list (${changedPaths.length} path(s))`
  } else {
    scopeLabel = options.mode === 'range' ? `git range ${options.range}` : 'staged changes'
    try {
      changedPaths = gitChangedPaths(root, options)
    } catch (error) {
      // Why: a git failure must not look like a verdict — report it and still exit 0.
      out.error(`policy-manifest-change-report: could not read ${scopeLabel}: ${error.message}`)
      out.error('policy-manifest-change-report: reporting nothing; this tool never fails a build.')
      return 0
    }
  }
  try {
    const policyFiles = discoverPolicyFiles(root)
    const classified = classifyChangedPaths(changedPaths, policyFiles)
    out.log(formatReport({ scopeLabel, classified, policyFileCount: policyFiles.length }))
  } catch (error) {
    // Why: "always exits 0" has to survive a crash too, or the promise in the header is false.
    out.error(`policy-manifest-change-report: could not build the report: ${error.message}`)
    out.error('policy-manifest-change-report: reporting nothing; this tool never fails a build.')
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), path.resolve(import.meta.dirname, '..', '..'))
}
