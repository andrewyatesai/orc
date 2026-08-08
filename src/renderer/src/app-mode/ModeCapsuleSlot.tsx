/**
 * The three layout slots a mode may occupy — `docs/reference/app-modes.md` §5.2.
 *
 * A capsule is the ONLY way a mode adds UI. Everything else it can do is gate
 * (hide an existing surface) or reword (swap an i18n key). That is what keeps a
 * fourth mode down to one manifest entry.
 *
 * Three rules this file exists to hold:
 *
 * 1. **An unknown capsule id renders nothing, silently.** A manifest naming a
 *    capsule this build does not ship is a downgrade, not a crash — the mode
 *    degrades to "no body", and the settings escape hatch (§2.6) still works.
 * 2. **Each capsule is lazy and inside its own error boundary.** A throwing
 *    ALab console must not take down the shell that contains the way out of
 *    ALab.
 * 3. **Classic never reaches here.** `resolveModeCapsule` returns null for every
 *    Classic slot, so this component renders `null` and adds nothing to the
 *    Classic tree — not a wrapper, not a boundary, not a Suspense.
 */

import { Suspense, lazy, type ComponentType } from 'react'
import { RecoverableRenderErrorBoundary } from '@/components/error-boundaries/RecoverableRenderErrorBoundary'
import {
  resolveModeCapsule,
  resolveModeManifest
} from '../../../shared/app-mode/app-mode-capability'
import type { AppModeCapsuleId, AppModeSlotId } from '../../../shared/app-mode/app-mode-manifest'

/**
 * Every capsule this build ships. A mode may only name an id present here; the
 * lookup is by key so a manifest cannot inject an arbitrary import path.
 */
const CAPSULES: Partial<Record<AppModeCapsuleId, ComponentType>> = {
  'alab.mission-control': lazy(() => import('@/components/alab/MissionControl')),
  'alab.mission-strip': lazy(() => import('@/components/alab/MissionStrip')),
  'story-world.stage': lazy(() => import('@/components/story-world/StoryStage')),
  'story-world.worlds-list': lazy(() => import('@/components/story-world/MyWorldsList'))
}

export type ModeCapsuleSlotProps = {
  mode: unknown
  slot: AppModeSlotId
}

export function ModeCapsuleSlot({ mode, slot }: ModeCapsuleSlotProps): React.JSX.Element | null {
  const capsuleId = resolveModeCapsule(mode, slot)
  if (!capsuleId) {
    return null
  }
  const Capsule = CAPSULES[capsuleId]
  if (!Capsule) {
    // A manifest naming a capsule this build does not have. Silent by design —
    // see rule 1. The mode simply has no body in that slot.
    return null
  }
  return (
    <RecoverableRenderErrorBoundary
      boundaryId={`app-mode:${slot}`}
      surface={resolveModeManifest(mode).errorBoundarySurface}
    >
      {/* No fallback content: a flash of "Loading…" where the workspace should
          be reads as breakage. The outgoing tree stays painted instead. */}
      <Suspense fallback={null}>
        <Capsule />
      </Suspense>
    </RecoverableRenderErrorBoundary>
  )
}

/** True when this mode replaces the centre region wholesale, so the caller can
 *  skip the Classic `activeView` chain entirely (§2.6's structural branch). */
export function modeOwnsWorkspaceBody(mode: unknown): boolean {
  return resolveModeCapsule(mode, 'workspace-body') !== null
}
