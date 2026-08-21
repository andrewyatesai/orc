// @vitest-environment happy-dom

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillFreshnessInventory, SkillUpdateRun } from '../../../../shared/skill-freshness'
import { SkillFreshnessUpdateDialog } from './SkillFreshnessUpdateDialog'
import {
  consumeSkillFreshnessUpdateDialogRequest,
  requestSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'
import { _resetSkillUpdateRunStore } from './skill-update-run-store'
import { _resetOfflineSkillUpdateRun } from './skill-offline-update-run'

const mocks = vi.hoisted(() => ({
  inventory: null as SkillFreshnessInventory | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  notifyChanged: vi.fn(),
  installOffline: vi.fn(async (_args: { names: readonly string[]; skillLabel: string }) => true)
}))

vi.mock('@/lib/bundled-skill-offline-install', () => ({
  installBundledSkillsOffline: mocks.installOffline
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  useSkillFreshness: () => ({
    inventory: mocks.inventory,
    loading: mocks.loading,
    error: mocks.error,
    refresh: mocks.refresh
  })
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.notifyChanged
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div data-dialog-open="true">{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>
}))

// Both collapsible wrappers forward className: the containment classes under test
// (min-w-0 on the root and the content) are exactly what these assertions read.
vi.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({
    children,
    defaultOpen = false,
    ...rest
  }: { children?: ReactNode; defaultOpen?: boolean } & Record<string, unknown>) => {
    const [open] = useState(defaultOpen)
    return (
      <div {...rest} data-collapsible-open={String(open)}>
        {children}
      </div>
    )
  },
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ className, children }: { className?: string; children?: ReactNode }) => (
    <div className={className} data-collapsible-content>
      {children}
    </div>
  )
}))

const skillsApi = {
  startUpdateRun: vi.fn(async () => ({ started: true as const })),
  cancelUpdateRun: vi.fn(async () => {}),
  acknowledgeUpdateRun: vi.fn(async () => {}),
  getUpdateRun: vi.fn(async (): Promise<SkillUpdateRun> => ({ state: 'idle' })),
  onUpdateRun: vi.fn((callback: (run: SkillUpdateRun) => void) => {
    pushRun = callback
    return () => {}
  })
}
let pushRun: ((run: SkillUpdateRun) => void) | null = null

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderDialog(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<SkillFreshnessUpdateDialog />)
  })
}

async function openViaRequest(): Promise<void> {
  await act(async () => {
    requestSkillFreshnessUpdateDialog()
  })
}

async function emitRun(run: SkillUpdateRun): Promise<void> {
  await act(async () => {
    pushRun?.(run)
  })
}

describe('SkillFreshnessUpdateDialog overflow containment', () => {
  beforeEach(() => {
    consumeSkillFreshnessUpdateDialogRequest()
    _resetSkillUpdateRunStore()
    _resetOfflineSkillUpdateRun()
    mocks.installOffline.mockReset()
    mocks.installOffline.mockResolvedValue(true)
    pushRun = null
    mocks.inventory = {
      schemaVersion: 1,
      installations: [],
      eligibleUpdateNames: [],
      scanIssues: [],
      scannedAt: 1
    }
    mocks.loading = false
    mocks.error = null
    mocks.refresh.mockReset()
    mocks.notifyChanged.mockReset()
    skillsApi.startUpdateRun.mockClear()
    skillsApi.onUpdateRun.mockClear()
    ;(window as unknown as { api: { skills: typeof skillsApi } }).api = { skills: skillsApi }
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
  })

  it('keeps a failed run log and message inside the dialog grid', async () => {
    // A 1000-char run of one character has no break opportunity; without the
    // containment classes it stretches the flex row and overflows the dialog.
    const unbrokenOutput = 'A'.repeat(1000)
    const unbrokenMessage = 'B'.repeat(1000)
    await renderDialog()
    await openViaRequest()
    await emitRun({
      state: 'error',
      names: ['orca-cli'],
      failedNames: ['orca-cli'],
      finishedAt: 3,
      output: unbrokenOutput,
      message: unbrokenMessage
    })

    const output = container?.querySelector('pre')
    expect(output?.textContent).toContain(unbrokenOutput)
    expect(output?.className).toContain('[overflow-wrap:anywhere]')
    expect(output?.className).not.toContain('break-words')
    expect(output?.parentElement?.className).toContain('min-w-0')
    expect(output?.closest('[data-collapsible-open]')?.className).toContain('min-w-0')

    const message = Array.from(container?.querySelectorAll('p') ?? []).find(
      (candidate) => candidate.textContent === unbrokenMessage
    )
    expect(message?.className).toContain('[overflow-wrap:anywhere]')
    expect(message?.className).not.toContain('break-words')
    expect(message?.parentElement?.className).toContain('min-w-0')
  })

  it('wraps an unbroken scan error inside the dialog grid', async () => {
    const unbrokenError = 'C'.repeat(1000)
    mocks.inventory = null
    mocks.error = unbrokenError
    await renderDialog()
    await openViaRequest()

    const error = Array.from(container?.querySelectorAll('p') ?? []).find(
      (candidate) => candidate.textContent === unbrokenError
    )
    expect(error?.className).toContain('min-w-0')
    expect(error?.className).toContain('[overflow-wrap:anywhere]')
  })
})
