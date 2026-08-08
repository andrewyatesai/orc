/**
 * The only sanctioned reader of the mode registry — `docs/reference/app-modes.md`
 * §2.4.
 *
 * **Every export takes `mode: unknown` and normalizes internally.** The registry
 * is never indexed with a caller-supplied value. That is what turns the
 * web-localStorage case, the pre-hydration-null case and the unknown-`Repo`-value
 * case from crashes into a silent, correct Classic.
 *
 * **Containment rule:** `mode === 'story-world'` / `mode === 'alab'` comparisons
 * are forbidden outside `src/shared/app-mode/*`, and so are bare
 * `APP_MODE_REGISTRY[` indexes. `app-mode-comparison-containment.test.ts`
 * enforces it by walking the tracked tree. With that rule the mode diff is
 * grep-auditable to a fixed file set, and a fourth mode costs one manifest.
 */

import { normalizeAppModeId } from './app-mode-id'
import type { AppModeCapsuleId, AppModeManifest, AppModeSlotId } from './app-mode-manifest'
import { APP_MODE_REGISTRY } from './app-mode-registry'
import type { AppSurfaceId } from './app-mode-surfaces'

export function resolveModeManifest(mode: unknown): AppModeManifest {
  return APP_MODE_REGISTRY[normalizeAppModeId(mode)]
}

export function isSurfaceEnabled(mode: unknown, surface: AppSurfaceId): boolean {
  return resolveModeManifest(mode).surfaces[surface]
}

export function resolveModeCapsule(mode: unknown, slot: AppModeSlotId): AppModeCapsuleId | null {
  return resolveModeManifest(mode).capsules[slot] ?? null
}

export function resolveModeStyleVariables(
  mode: unknown
): Readonly<Record<string, string>> | undefined {
  return resolveModeManifest(mode).styleVariables
}

/** True when the mode replaces the centre region wholesale. The settings escape
 *  hatch (§2.6) lives at the render site, not here. */
export function hasModeBody(mode: unknown): boolean {
  return resolveModeCapsule(mode, 'workspace-body') !== null
}

/** Powers the Settings pane's "what each mode changes" disclosure. Generated
 *  from the same data that drives behaviour, so the explanation cannot drift
 *  from what the mode actually does. */
export function diffSurfacesAgainstClassic(mode: unknown): AppSurfaceId[] {
  const target = resolveModeManifest(mode).surfaces
  const classic = APP_MODE_REGISTRY.classic.surfaces
  return (Object.keys(classic) as AppSurfaceId[]).filter(
    (surface) => classic[surface] !== target[surface]
  )
}
