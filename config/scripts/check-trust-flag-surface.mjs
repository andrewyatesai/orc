#!/usr/bin/env node
// Every `-Z` trust flag in rust/.cargo/config.toml must be one the INSTALLED
// Trust stage2 actually accepts.
//
// WHY THIS IS A SCRIPT AND NOT A COMMENT: the config already says "PROBE before
// editing either flag — both spellings are a property of the INSTALLED stage2,
// not of the calendar". That instruction has now failed twice. The flag surface
// has flipped three times:
//   * `-Zno-trust-verify` was deleted, so every unit failed flag-parse.
//   * It came back, and `-Ztrust-verify=off` was the one the doctest frontend took.
//   * Now `-Ztrust-verify`, `-Ztrust-policy` and
//     `-Ztrust-verify-function-budget-steps` are ALL gone, and the config still
//     set all three — so no unit under rust/ compiled and NOTHING SAID SO. The
//     workarounds that let builds proceed (clearing RUSTFLAGS, running from a
//     directory where the table is not read) compile as vanilla Rust with the
//     verifier silently off, which is the failure mode this repo keeps hitting.
//
// An unknown `-Z` is fatal on EVERY unit including build scripts, so the symptom
// is a total build failure that reads like a toolchain problem rather than a
// config problem. This check names the flag instead.
//
// EXIT: 0 when every configured flag is accepted, or when the Trust toolchain is
// not installed (a stable-only machine legitimately cannot check, and says so
// loudly rather than pretending). Non-zero when the toolchain IS present and the
// config names a flag it does not know.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../..', import.meta.url).pathname
const CONFIG = 'rust/.cargo/config.toml'

// Read the COMMITTED config: this repo carries ~1,700 uncommitted files from
// parallel sessions, so the working tree is not evidence of what ships.
function committed(path) {
  try {
    return execFileSync('git', ['show', `HEAD:${path}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  }
}

/** Flag NAMES only — `-Zfoo=bar` and `-Zfoo` both yield `foo`. */
function configuredFlags(toml) {
  const found = new Map()
  // Only the flag arrays, never the prose: the comments deliberately quote dead
  // spellings as history, and matching those would make this check cry wolf.
  const arrays = [...toml.matchAll(/^\s*(rustflags|rustdocflags)\s*=\s*\[([\s\S]*?)\]/gm)]
  for (const [, key, body] of arrays) {
    for (const [, flag] of body.matchAll(/"-Z([a-z0-9_-]+)(?:=[^"]*)?"/g)) {
      if (!found.has(flag)) {
        found.set(flag, key)
      }
    }
  }
  return found
}

/** Flag names the installed stage2 offers. Anchored, because `no-trust-verify=`
 *  CONTAINS `trust-verify=` — a substring match reports the dead flag as alive,
 *  which is exactly the false negative that hid this breakage. */
function offeredFlags() {
  let help
  try {
    help = execFileSync('rustup', ['run', 'trust', 'rustc', '-Z', 'help'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32e6,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  const names = new Set()
  for (const [, name] of help.matchAll(/^\s+-Z\s+([a-z0-9_-]+)=/gm)) {
    names.add(name)
  }
  return names
}

const configured = configuredFlags(committed(CONFIG))
if (configured.size === 0) {
  console.error(`[trust-flags] parsed no -Z flags out of ${CONFIG} — the parser or the file changed shape`)
  process.exit(1)
}

const offered = offeredFlags()
if (offered === null) {
  console.log('[trust-flags] SKIPPED — the `trust` rustup toolchain is not installed here, so the')
  console.log('              flag surface cannot be probed. Verification is NOT running on this')
  console.log('              machine; that is a stable-lane fact, not a passing check.')
  process.exit(0)
}
if (offered.size === 0) {
  console.error('[trust-flags] `rustc -Z help` produced no parseable flags — probe it by hand')
  process.exit(1)
}

const dead = [...configured].filter(([flag]) => !offered.has(flag))
console.log(`[trust-flags] ${configured.size} configured, ${offered.size} offered by the installed stage2`)

if (dead.length > 0) {
  console.error(`\n[trust-flags] ${dead.length} flag(s) in ${CONFIG} are NOT accepted:`)
  for (const [flag, key] of dead) {
    console.error(`  - -Z${flag}   (in ${key})`)
  }
  console.error('\nAn unknown -Z is fatal on EVERY unit, build scripts included, so nothing under')
  console.error('rust/ compiles while this is true. See what the stage2 does offer:')
  console.error('  rustup run trust rustc -Z help | grep trust')
  console.error('Do NOT "fix" this by clearing RUSTFLAGS or building from a directory where the')
  console.error('table is not read — both compile as vanilla Rust with the verifier silently off.')
  process.exit(1)
}
console.log('[trust-flags] every configured trust flag is accepted by the installed stage2.')
