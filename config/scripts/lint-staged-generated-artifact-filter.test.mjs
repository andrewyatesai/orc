// The bug this locks: lint-staged selects by extension, so the committed
// wasm-bindgen glue reached `oxlint`, which ignores those paths and then exits
// non-zero on the empty list — every aterm pin bump failed at pre-commit. Handing
// the glue to `oxfmt --write` would also break the byte-exact artifact SHA pin.

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import config from '../../.lintstagedrc.mjs'

const JS_GLOB = '*.{ts,tsx,js,jsx,mjs,mts,cts}'
const JSON_GLOB = '*.{json,css}'

const ATERM_DIR = 'src/renderer/src/lib/pane-manager/aterm'
const GENERATED_GLUE = [
  `${ATERM_DIR}/aterm_wasm.js`,
  `${ATERM_DIR}/aterm_wasm.d.ts`,
  `${ATERM_DIR}/aterm_gpu_web.js`,
  `${ATERM_DIR}/aterm_gpu_web.d.ts`
].map((path) => resolve(process.cwd(), path))

const SOURCE_FILE = resolve(process.cwd(), 'src/main/daemon/rust-git-addon.ts')

describe('lint-staged generated-artifact filter', () => {
  it('emits no commands when every staged file is one oxlint ignores', async () => {
    // The exact set an aterm pin bump stages — this returned commands before, and
    // oxlint failed the commit on the all-ignored list.
    expect(await config[JS_GLOB](GENERATED_GLUE)).toEqual([])
  })

  it('emits no commands for the generated artifact pin json', async () => {
    const pin = [resolve(process.cwd(), `${ATERM_DIR}/aterm_wasm_artifact_pin.json`)]
    expect(await config[JSON_GLOB](pin)).toEqual([])
  })

  it('still runs the full command chain for ordinary source files', async () => {
    const commands = await config[JS_GLOB]([SOURCE_FILE])
    expect(commands).toHaveLength(3)
    expect(commands[0]).toMatch(/^oxlint /)
    expect(commands[1]).toMatch(/^oxlint --config config\/oxlint-react-doctor\.json /)
    expect(commands[2]).toMatch(/^oxfmt --write /)
  })

  it('drops only the ignored files from a mixed list, so oxfmt never rewrites glue', async () => {
    const commands = await config[JS_GLOB]([...GENERATED_GLUE, SOURCE_FILE])
    expect(commands).toHaveLength(3)
    for (const command of commands) {
      expect(command).toContain('rust-git-addon.ts')
      expect(command).not.toContain('aterm_wasm')
      expect(command).not.toContain('aterm_gpu_web')
    }
  })
})
