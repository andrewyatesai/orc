import { describe, it, vi } from 'vitest'
import { RPC_METHOD_GROUPS, RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES } from './index'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('dump', () => {
  it('dumps', () => {
    const lines: string[] = []
    for (const [group, methods] of Object.entries(RPC_METHOD_GROUPS)) {
      const policy = (RPC_METHOD_GROUP_CALLER_SCOPE_POLICIES as Record<string, unknown>)[group] as
        | { kind: string }
        | undefined
      lines.push(
        `GROUP ${group} [${policy?.kind ?? 'LOCAL_ONLY'}] n=${methods.length}: ${methods
          .map((m) => m.name)
          .join(' ')}`
      )
    }
    // eslint-disable-next-line
    require('node:fs').writeFileSync('/tmp/orca-rpc-groups.txt', lines.join('\n'))
  })
})
