/**
 * The mode manifest — `docs/reference/app-modes.md` §2.3.
 *
 * **Anti-DSL guard.** No expression, no condition on runtime state, no template
 * string, no `$ref`, no `extends`. A manifest is JSON. When a mode needs to
 * compute, it names a capsule instead.
 *
 * This is enforced by a type-level test asserting `AppModeManifest extends
 * JsonValue`. That test is the only mechanical stop on the first
 * `when: { activeWorktreeHasAgents: true }` field — which would end this design
 * and would look perfectly reasonable in review.
 */

import type { AppIconId } from '../app-icon'
import type { ReactErrorBoundarySurface } from '../crash-reporting'
import type { AppModeId } from './app-mode-id'
import type { AppSurfaceId } from './app-mode-surfaces'

/** The three layout positions a mode may occupy. Everything else is gated, not
 *  placed — see §5.1 for why `WindowControls` and `<Terminal/>` are not here. */
export type AppModeSlotId = 'workspace-body' | 'left-sidebar-body' | 'titlebar-strip'

export type AppModeCapsuleId =
  | 'alab.mission-control'
  | 'alab.mission-strip'
  | 'story-world.stage'
  | 'story-world.worlds-list'
  | 'story-world.strip-header'

export type AppModeManifest = {
  readonly manifestVersion: 1
  readonly id: AppModeId
  readonly labelKey: string
  readonly descriptionKey: string
  /** Exhaustive by construction — every surface has an explicit answer. */
  readonly surfaces: Readonly<Record<AppSurfaceId, boolean>>
  readonly capsules: Readonly<Partial<Record<AppModeSlotId, AppModeCapsuleId>>>
  /** CSS custom properties applied to the workspace subtree root, never to
   *  documentElement — a root class cannot express two workspaces in two modes,
   *  which the per-project rung needs. `undefined` is Classic's no-op. */
  readonly styleVariables: Readonly<Record<string, string>> | undefined
  /** i18n KEY -> i18n KEY. Never key -> English literal, or the copy stops being
   *  translatable the moment a mode touches it. */
  readonly copyKeyRemap: Readonly<Record<string, string>> | null
  readonly appIcon: AppIconId
  /** Appended to the macOS app-menu label only. Never `app.setName` — that
   *  derives the Keychain item and the userData directory (§2.1). */
  readonly appMenuLabelSuffix: string | null
  readonly errorBoundarySurface: ReactErrorBoundarySurface
}
