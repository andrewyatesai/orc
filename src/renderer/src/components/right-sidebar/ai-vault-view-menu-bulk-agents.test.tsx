// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../../../shared/ai-vault-types'
import { VaultViewMenu } from './AiVaultPanelControls'

// Why: render the real VaultViewMenu but stub the Radix primitives to plain elements so the
// bulk-action wiring (disabled gating + the boolean handed to onAllAgentsEnabledChange) is
// exercised without Radix's portal/pointer machinery.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Passthrough = ({ children }: { children?: ReactNode }): ReactNode => <>{children}</>
  const Item = ({
    children,
    disabled,
    onSelect
  }: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: (event: Event) => void
  }): ReactNode => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.(new Event('select'))}>
      {children}
    </button>
  )
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuLabel: Passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: Item,
    DropdownMenuCheckboxItem: Passthrough,
    DropdownMenuRadioGroup: Passthrough,
    DropdownMenuRadioItem: Passthrough
  }
})

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => <span data-testid="agent-icon" />
}))

function renderMenu(agents: readonly AiVaultAgent[]): {
  onAllAgentsEnabledChange: ReturnType<typeof vi.fn>
  bulkButton: (label: string) => HTMLButtonElement
} {
  const onAllAgentsEnabledChange = vi.fn()
  const { container } = render(
    <VaultViewMenu
      agents={agents}
      sort="updated"
      group="project"
      hideEmptySessions={false}
      adjustmentCount={0}
      onAgentEnabledChange={vi.fn()}
      onAllAgentsEnabledChange={onAllAgentsEnabledChange}
      onSortChange={vi.fn()}
      onGroupChange={vi.fn()}
      onHideEmptySessionsChange={vi.fn()}
      onReset={vi.fn()}
    />
  )
  const bulkButton = (label: string): HTMLButtonElement => {
    const match = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === label
    )
    if (!match) {
      throw new Error(`no bulk-action button labelled ${label}`)
    }
    return match as HTMLButtonElement
  }
  return { onAllAgentsEnabledChange, bulkButton }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('VaultViewMenu agent bulk actions', () => {
  it('clears every agent from a full selection', () => {
    const { onAllAgentsEnabledChange, bulkButton } = renderMenu([...AI_VAULT_AGENTS])

    expect(bulkButton('Select all').disabled).toBe(true)
    expect(bulkButton('Clear').disabled).toBe(false)

    fireEvent.click(bulkButton('Clear'))
    expect(onAllAgentsEnabledChange).toHaveBeenCalledWith(false)
  })

  it('re-enables every agent from an empty selection', () => {
    const { onAllAgentsEnabledChange, bulkButton } = renderMenu([])

    expect(bulkButton('Select all').disabled).toBe(false)
    expect(bulkButton('Clear').disabled).toBe(true)

    fireEvent.click(bulkButton('Select all'))
    expect(onAllAgentsEnabledChange).toHaveBeenCalledWith(true)
  })

  it('leaves both bulk actions live for a partial selection', () => {
    const { bulkButton } = renderMenu([AI_VAULT_AGENTS[0]])

    expect(bulkButton('Select all').disabled).toBe(false)
    expect(bulkButton('Clear').disabled).toBe(false)
  })
})
