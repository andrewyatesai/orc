// @vitest-environment happy-dom

import { createElement, useEffect } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../../shared/constants'
import type { OnboardingState } from '../../../../shared/types'

const trackMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/telemetry', () => ({
  track: trackMock
}))

import {
  resolveOnboardingPermissionMode,
  buildCompletedOnboardingNotificationSettings,
  buildOnboardingDismissedPayload,
  useCloseWith,
  type DismissedExtras,
  trackOnboardingDismissed
} from './use-onboarding-flow-persistence'
import type { StepNumber } from './use-onboarding-flow-types'

type CloseWithCallback = (
  outcome: 'completed' | 'dismissed',
  lastStepReached: StepNumber,
  completedPath?: 'add_project_modal',
  dismissedExtras?: DismissedExtras
) => Promise<boolean>

function makeOnboardingState(): OnboardingState {
  return {
    ...getDefaultOnboardingState(),
    closedAt: Date.now(),
    outcome: 'completed',
    lastCompletedStep: 5
  }
}

function setApi(api: {
  onboarding: { update: ReturnType<typeof vi.fn> }
  starNag: { onboardingCompleted: ReturnType<typeof vi.fn> }
}): void {
  ;(window as unknown as { api: typeof api }).api = api
}

function CloseWithProbe(props: { onReady: (closeWith: CloseWithCallback) => void }): null {
  const closeWith = useCloseWith({
    onOnboardingChange: vi.fn(),
    startTimeRef: { current: Date.now() },
    setError: vi.fn()
  })
  useEffect(() => props.onReady(closeWith), [closeWith, props])
  return null
}

function renderCloseWithProbe(onReady: (closeWith: CloseWithCallback) => void): {
  root: Root
  container: HTMLDivElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(CloseWithProbe, { onReady })))
  return { root, container }
}

describe('onboarding flow persistence', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    trackMock.mockClear()
    setApi({
      onboarding: { update: vi.fn().mockResolvedValue(makeOnboardingState()) },
      starNag: { onboardingCompleted: vi.fn().mockResolvedValue(undefined) }
    })
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    vi.useRealTimers()
  })

  it('builds dismissed telemetry with the triggering advance path', () => {
    expect(
      buildOnboardingDismissedPayload(3, {
        durationMs: 250,
        advancedVia: 'keyboard'
      })
    ).toEqual({
      last_step: 3,
      duration_ms: 250,
      advanced_via: 'keyboard'
    })
  })

  it('tracks dismissed onboarding telemetry with the triggering advance path', () => {
    trackOnboardingDismissed(3, {
      durationMs: 250,
      advancedVia: 'keyboard'
    })

    expect(trackMock).toHaveBeenCalledWith('onboarding_dismissed', {
      last_step: 3,
      duration_ms: 250,
      advanced_via: 'keyboard'
    })
  })

  it('preserves explicit focus notification suppression when completing onboarding', () => {
    const notifications = buildCompletedOnboardingNotificationSettings({
      enabled: false,
      agentTaskComplete: false,
      terminalBell: false,
      longCommandComplete: true,
      longCommandThresholdSeconds: 15,
      terminalAppNotifications: true,
      suppressWhenFocused: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60
    })

    expect(notifications).toEqual({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      longCommandComplete: true,
      longCommandThresholdSeconds: 15,
      terminalAppNotifications: true,
      suppressWhenFocused: false,
      customSoundId: 'two-tone',
      customSoundPath: null,
      customSoundVolume: 60
    })
  })

  it('schedules the star toast after every completed close path', async () => {
    let closeWith: CloseWithCallback | null = null
    ;({ root, container } = renderCloseWithProbe((callback) => {
      closeWith = callback
    }))

    await act(async () => {
      await closeWith?.('completed', 5)
    })

    const api = (
      window as unknown as {
        api: {
          starNag: { onboardingCompleted: ReturnType<typeof vi.fn> }
        }
      }
    ).api
    expect(api.starNag.onboardingCompleted).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(api.starNag.onboardingCompleted).toHaveBeenCalledTimes(1)
  })

  it('persists only the dismissed flag and skips retired checklist telemetry on completed close', async () => {
    // Why: the repository controller is gone — closeWith no longer accepts a checklist,
    // must write exactly { dismissed } (never spread wizard-added repo/folder keys), and
    // must not fire activation_checklist_item_completed.
    let closeWith: CloseWithCallback | null = null
    ;({ root, container } = renderCloseWithProbe((callback) => {
      closeWith = callback
    }))

    await act(async () => {
      await closeWith?.('completed', 5, 'add_project_modal')
    })

    const api = (
      window as unknown as {
        api: { onboarding: { update: ReturnType<typeof vi.fn> } }
      }
    ).api
    expect(api.onboarding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'completed',
        checklist: { dismissed: false }
      })
    )

    const trackedEvents = trackMock.mock.calls.map(([event]) => event)
    expect(trackedEvents).toContain('onboarding_completed')
    expect(trackedEvents).not.toContain('activation_checklist_item_completed')
  })
})

describe('resolveOnboardingPermissionMode', () => {
  it('keeps a stored safe profile safe when the binary toggle reads "on"', () => {
    // Why: safe never prompts, so it hydrates the yolo toggle as checked — continuing
    // onboarding untouched must not swap sandbox flags for bypass flags.
    expect(resolveOnboardingPermissionMode(true, 'safe')).toBe('safe')
  })

  it('maps the toggle to yolo/manual exactly as before for non-safe profiles', () => {
    expect(resolveOnboardingPermissionMode(true, 'yolo')).toBe('yolo')
    expect(resolveOnboardingPermissionMode(true, undefined)).toBe('yolo')
    expect(resolveOnboardingPermissionMode(true, 'garbage')).toBe('yolo')
    expect(resolveOnboardingPermissionMode(false, 'safe')).toBe('manual')
    expect(resolveOnboardingPermissionMode(false, undefined)).toBe('manual')
  })
})
