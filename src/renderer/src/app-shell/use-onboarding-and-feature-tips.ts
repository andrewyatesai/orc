import { useCallback, useEffect, useRef, useState } from 'react'
import type { OnboardingState } from '../../../shared/types'
import {
  getFeatureTipsAppOpenDecision,
  isCliFeatureTipCompleted
} from '../components/feature-tips/feature-tip-startup-gate'
import {
  trackCmdJPaletteFeatureTipShown,
  trackOrcaCliFeatureTipShown
} from '../components/feature-tips/feature-tip-telemetry'
import { onOnboardingReopened } from '../components/onboarding/show-onboarding-event'
import { shouldShowOnboarding } from '../components/onboarding/should-show-onboarding'
import type { useAppStore } from '../store'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type OnboardingActions = Pick<
  AppStoreState,
  | 'markFeatureTipsSeen'
  | 'openModal'
  | 'setContextualToursAutoEligible'
  | 'setContextualToursOnboardingVisible'
>

type OnboardingAndFeatureTipsParams = {
  actions: OnboardingActions
  activeModal: AppStoreState['activeModal']
  activeView: AppStoreState['activeView']
  contextualToursAutoEligible: AppStoreState['contextualToursAutoEligible']
  featureInteractions: AppStoreState['featureInteractions']
  featureTipsSeenIds: AppStoreState['featureTipsSeenIds']
  persistedUIReady: boolean
  settings: AppStoreState['settings']
}

type OnboardingAndFeatureTips = {
  onboarding: OnboardingState | null
  onboardingLoaded: boolean
  setOnboarding: (onboarding: OnboardingState) => void
  setOnboardingLoaded: (loaded: boolean) => void
  shouldRenderOnboarding: boolean
  onboardingSettingsDetourActive: boolean
  beginOnboardingSettingsDetour: () => void
}

export function useOnboardingAndFeatureTips({
  actions,
  activeModal,
  activeView,
  contextualToursAutoEligible,
  featureInteractions,
  featureTipsSeenIds,
  persistedUIReady,
  settings
}: OnboardingAndFeatureTipsParams): OnboardingAndFeatureTips {
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null)
  const [onboardingLoaded, setOnboardingLoaded] = useState(false)
  const [onboardingSettingsDetour, setOnboardingSettingsDetour] = useState(false)
  const [featureTipCliInstalled, setFeatureTipCliInstalled] = useState<boolean | null>(null)
  const promptedThisSessionRef = useRef(false)
  const suppressedByOnboardingThisSessionRef = useRef(false)

  const shouldRenderOnboarding = onboarding !== null && shouldShowOnboarding(onboarding)
  const onboardingSettingsDetourActive =
    onboardingSettingsDetour && activeView === 'settings' && shouldRenderOnboarding
  if (onboardingSettingsDetour && !onboardingSettingsDetourActive) {
    // Why: the detour is valid only while Settings is onscreen; clear it during render so onboarding resumes without an extra Effect pass.
    setOnboardingSettingsDetour(false)
  }

  useEffect(() => {
    return onOnboardingReopened(setOnboarding)
  }, [])

  useEffect(() => {
    // Why: suppress tours until onboarding state is known (null = loading) so a first-run user can't mark a tour seen before onboarding appears.
    const suppressTours = !onboardingLoaded || shouldShowOnboarding(onboarding)
    actions.setContextualToursOnboardingVisible(suppressTours)
  }, [actions, onboarding, onboardingLoaded])

  useEffect(() => {
    if (!persistedUIReady || !onboardingLoaded || contextualToursAutoEligible !== null) {
      return
    }
    // Why: rollout targets first-run onboarding users; existing profiles are classified once and never auto-toured.
    actions.setContextualToursAutoEligible(shouldShowOnboarding(onboarding))
  }, [actions, contextualToursAutoEligible, onboarding, onboardingLoaded, persistedUIReady])

  useEffect(() => {
    if (!persistedUIReady) {
      return
    }
    let cancelled = false
    void window.api.cli
      .getInstallStatus()
      .then((status) => {
        if (!cancelled) {
          setFeatureTipCliInstalled(isCliFeatureTipCompleted(status))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFeatureTipCliInstalled(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [persistedUIReady])

  useEffect(() => {
    const featureTipsDecision = getFeatureTipsAppOpenDecision({
      activeModal,
      cliInstalled: featureTipCliInstalled,
      featureTipsSeenIds,
      featureInteractions,
      onboarding,
      persistedUIReady,
      promptedThisSession: promptedThisSessionRef.current,
      settings,
      suppressedByOnboardingThisSession: suppressedByOnboardingThisSessionRef.current
    })

    if (featureTipsDecision.kind === 'suppress-for-onboarding') {
      // Why: first-run users should finish onboarding without a second education modal in the same session.
      suppressedByOnboardingThisSessionRef.current = true
      return
    }
    if (featureTipsDecision.kind !== 'open') {
      return
    }

    promptedThisSessionRef.current = true
    if (featureTipsDecision.tipId === 'orca-cli') {
      trackOrcaCliFeatureTipShown('app_open')
    } else if (featureTipsDecision.tipId === 'cmd-j-palette') {
      trackCmdJPaletteFeatureTipShown('app_open')
    }
    // Why: mark seen on show so a quit/crash before dismiss doesn't reappear it next launch.
    actions.markFeatureTipsSeen([featureTipsDecision.tipId])
    actions.openModal('feature-tips', { source: 'app_open', tipId: featureTipsDecision.tipId })
  }, [
    activeModal,
    actions,
    featureTipCliInstalled,
    featureInteractions,
    featureTipsSeenIds,
    onboarding,
    persistedUIReady,
    settings
  ])

  const beginOnboardingSettingsDetour = useCallback(() => {
    setOnboardingSettingsDetour(true)
  }, [])

  return {
    onboarding,
    onboardingLoaded,
    setOnboarding,
    setOnboardingLoaded,
    shouldRenderOnboarding,
    onboardingSettingsDetourActive,
    beginOnboardingSettingsDetour
  }
}
