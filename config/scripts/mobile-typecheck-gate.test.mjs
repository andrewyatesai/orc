import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const readPackageJson = (relativePath) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'))

const rootPackageJson = readPackageJson('../../package.json')
const mobilePackageJson = readPackageJson('../../mobile/package.json')

const MOBILE_TYPECHECK = 'pnpm --dir mobile typecheck'
const MOBILE_TYPECHECK_SCRIPT = 'pnpm run typecheck:mobile'

// `&&` is the only legal joiner: `;`, `|`, `||` and a backgrounding `&` all
// detach mobile's tsc from the script's exit code, so the gate can never fail.
const SWALLOWS_FAILURE = /[;|]|(?<!&)&(?!&)/
const ENSURE_PREREQUISITE = /^pnpm run (ensure:[\w:.-]+)$/

const steps = (script) => script.split('&&').map((step) => step.trim())

/**
 * `typecheck:mobile` must end in the mobile delegation and let its status through.
 * Anything ahead of it may only be an `ensure:*` prerequisite package.json really
 * defines — that keeps setup (mobile pins its own TypeScript, so its tree has to be
 * installed first) legal while still catching a swap to some other command.
 */
function mobileDelegationViolations(scripts) {
  const script = scripts['typecheck:mobile']
  if (typeof script !== 'string') {
    return ['typecheck:mobile is missing']
  }
  if (SWALLOWS_FAILURE.test(script)) {
    return [`typecheck:mobile discards the mobile tsc exit code: ${script}`]
  }
  const parts = steps(script)
  const violations =
    parts.at(-1) === MOBILE_TYPECHECK ? [] : [`does not end in ${MOBILE_TYPECHECK}`]
  for (const step of parts.slice(0, -1)) {
    const prerequisite = ENSURE_PREREQUISITE.exec(step)?.[1]
    if (!prerequisite) {
      violations.push(`step before the mobile typecheck is not an ensure:* prerequisite: ${step}`)
    } else if (!(prerequisite in scripts)) {
      violations.push(`prerequisite ${prerequisite} is not a package.json script`)
    }
  }
  return violations
}

/** The root gate must run the mobile leg as an `&&` step, so its failure lands. */
function rootGateViolations(scripts) {
  const script = scripts.typecheck
  if (typeof script !== 'string') {
    return ['typecheck is missing']
  }
  if (SWALLOWS_FAILURE.test(script)) {
    return [`typecheck discards a leg's exit code: ${script}`]
  }
  return steps(script).includes(MOBILE_TYPECHECK_SCRIPT)
    ? []
    : [`does not run ${MOBILE_TYPECHECK_SCRIPT}`]
}

// Why: mobile/ is outside every root tsconfig and outside the type-aware
// lint paths, so its never-guarded classifiers (e.g. github-check-summary)
// are only compile-checked if the root typecheck gate reaches into mobile.
describe('mobile typecheck gate', () => {
  it('root typecheck script runs the mobile typecheck', () => {
    expect(rootGateViolations(rootPackageJson.scripts)).toEqual([])
  })

  it('typecheck:mobile delegates to the mobile package', () => {
    expect(mobileDelegationViolations(rootPackageJson.scripts)).toEqual([])
  })

  it('the mobile package typecheck is a real compile, not a stub', () => {
    // Delegating to a script that compiles nothing is the same empty gate.
    expect(mobilePackageJson.scripts.typecheck).toMatch(/(?:^|\s)tsc(?:\s|$)/)
    expect(mobilePackageJson.scripts.typecheck).toContain('--noEmit')
  })
})

// The drift above is only caught if these stay red for the shipped assertions.
describe('mobile typecheck gate rejects drift', () => {
  const withMobileScript = (script) => ({ ...rootPackageJson.scripts, 'typecheck:mobile': script })

  it('accepts the bare delegation it was originally written against', () => {
    expect(mobileDelegationViolations(withMobileScript(MOBILE_TYPECHECK))).toEqual([])
  })

  it.each([
    ['dropped entirely', undefined],
    ['pointed at a root tsconfig instead', 'tsc --noEmit -p config/tsconfig.tc.web.json'],
    ['made unfailable', `${MOBILE_TYPECHECK} || true`],
    ['exit code discarded by a trailing step', `${MOBILE_TYPECHECK}; echo done`],
    ['backgrounded', `${MOBILE_TYPECHECK} &`],
    ['piped away', `${MOBILE_TYPECHECK} | tee mobile-typecheck.log`],
    ['fronted by an unrelated command', `pnpm run build && ${MOBILE_TYPECHECK}`],
    [
      'fronted by a prerequisite that does not exist',
      `pnpm run ensure:ghost && ${MOBILE_TYPECHECK}`
    ]
  ])('flags typecheck:mobile %s', (_case, script) => {
    const scripts = withMobileScript(script)
    if (script === undefined) {
      delete scripts['typecheck:mobile']
    }
    expect(mobileDelegationViolations(scripts)).not.toEqual([])
  })

  it.each([
    ['drops the mobile leg', 'tsc --noEmit -p config/tsconfig.node.json'],
    [
      'makes the mobile leg unfailable',
      `tsc --noEmit -p config/tsconfig.node.json && ${MOBILE_TYPECHECK_SCRIPT} || true`
    ]
  ])('flags a root typecheck that %s', (_case, script) => {
    expect(rootGateViolations({ ...rootPackageJson.scripts, typecheck: script })).not.toEqual([])
  })
})
