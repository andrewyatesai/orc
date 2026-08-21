import { useWindowStreamVisible } from '@/hooks/use-window-stream-visibility'

/**
 * Whether the remote browser screencast subscription should be open for this pane.
 *
 * Parks the screencast when the pane is inactive (background tab) OR the whole window is hidden
 * (minimize / occlusion / display sleep) past the grace period — neither of which the tab gate
 * alone catches. Returning to the pane resumes immediately. The caller's open/close effect keys
 * off this boolean, so a false→true flip reopens and a true→false flip tears the stream down.
 */
export function useRemoteBrowserStreamActive(isActive: boolean): boolean {
  const windowVisibleForStream = useWindowStreamVisible()
  return isActive && windowVisibleForStream
}
