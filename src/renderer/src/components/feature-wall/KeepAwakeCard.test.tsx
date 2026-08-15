// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { getAgentAwakeTitle } from '../settings/agent-awake-copy'
import { KeepAwakeCard } from './KeepAwakeCard'

afterEach(cleanup)

describe('KeepAwakeCard', () => {
  it('enables keep-awake from off through the consolidated switch', () => {
    const updateSettings = vi.fn()

    render(
      <KeepAwakeCard
        settings={{ ...getDefaultSettings('/home/tester'), keepComputerAwakeWhileAgentsRun: false }}
        updateSettings={updateSettings}
      />
    )

    fireEvent.click(screen.getByRole('switch', { name: getAgentAwakeTitle() }))

    expect(updateSettings).toHaveBeenCalledWith({ keepComputerAwakeWhileAgentsRun: true })
  })

  it('disables keep-awake when already on', () => {
    const updateSettings = vi.fn()

    render(
      <KeepAwakeCard
        settings={{ ...getDefaultSettings('/home/tester'), keepComputerAwakeWhileAgentsRun: true }}
        updateSettings={updateSettings}
      />
    )

    fireEvent.click(screen.getByRole('switch', { name: getAgentAwakeTitle() }))

    expect(updateSettings).toHaveBeenCalledWith({ keepComputerAwakeWhileAgentsRun: false })
  })
})
