import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { initGitWasmForTestFromBytes } from '@/lib/git-wasm/git-line-stats'
import { buildFolderWorkspaceLinkedStartupPlan } from './folder-workspace-linked-startup-plan'

// Why: the startup-plan builders live in the Rust orca-git wasm and return null
// until it is ready, so the assertion below is vacuous without this init.
beforeAll(() => {
  initGitWasmForTestFromBytes(
    readFileSync(join(__dirname, '../../lib/git-wasm/orca_git_wasm_bg.wasm'))
  )
})

describe('buildFolderWorkspaceLinkedStartupPlan', () => {
  it('uses cmd quoting for configured arguments on local Windows', () => {
    const plan = buildFolderWorkspaceLinkedStartupPlan({
      agent: 'hermes',
      linkedWorkItem: {
        provider: 'github',
        type: 'issue',
        number: 42,
        title: 'Restore linked quick-create',
        url: 'https://github.com/stablyai/orca/issues/42',
        repoId: 'repo-1'
      },
      note: '',
      agentCmdOverrides: {},
      agentArgs: '--provider "value with space"',
      platform: 'win32',
      shell: 'cmd',
      isRemote: false
    })

    expect(plan?.launchCommand).toBe('hermes --tui "--provider" "value with space"')
  })
})
