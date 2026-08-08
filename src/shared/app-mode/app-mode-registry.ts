/**
 * The three built-in manifests — `docs/reference/app-modes.md` §2.3, §6, §7, §8.
 *
 * Written out in full, with no inheritance and no merge: three explicit records
 * diff better in review than two plus a merge function, and the whole point of
 * the manifest is that you can read what a mode does without running anything.
 *
 * Classic's definition is a proof obligation, not a convenience — every surface
 * true, no capsules, no style variables, no copy remap, the default icon, no
 * menu suffix. `app-mode-classic-is-neutral.test.ts` asserts it deep-equals a
 * programmatically neutral manifest, which is strictly stronger than checking
 * the booleans: it also fails when a NEW non-boolean field lands with a
 * non-neutral Classic value.
 */

import { DEFAULT_APP_ICON_ID } from '../app-icon'
import type { AppModeId } from './app-mode-id'
import type { AppModeManifest } from './app-mode-manifest'
import { buildSurfaceRecord } from './app-mode-surfaces'

export const CLASSIC_MANIFEST: AppModeManifest = {
  manifestVersion: 1,
  id: 'classic',
  labelKey: 'appMode.classic',
  descriptionKey: 'appMode.classicDescription',
  surfaces: buildSurfaceRecord(true),
  capsules: {},
  styleVariables: undefined,
  copyKeyRemap: null,
  appIcon: DEFAULT_APP_ICON_ID,
  appMenuLabelSuffix: null,
  errorBoundarySurface: 'app-root'
}

/**
 * ALab — a supervisory console over a fleet of agent terminals (§8).
 *
 * De-emphasis, not restyling: `styleVariables` stays undefined because fleet
 * state maps onto existing status/chart tokens. What it hides is *workflow
 * mechanics*; the evidence surfaces (checks, diffs via the mission overlay) stay
 * reachable, because without them completion is 100% self-attestation.
 *
 * The status bar is kept exactly as the user configured it (§8.6) — surfaces are
 * boolean and `statusBarItems` is a user choice.
 */
export const ALAB_MANIFEST: AppModeManifest = {
  manifestVersion: 1,
  id: 'alab',
  labelKey: 'appMode.alab',
  descriptionKey: 'appMode.alabDescription',
  surfaces: {
    ...buildSurfaceRecord(true),
    // Hidden: file/diff workflow mechanics the supervisor does not drive.
    'rightSidebar.explorer': false,
    'rightSidebar.sourceControl': false,
    editorTabs: false,
    diffSurfaces: false,
    titlebarTabs: false,
    tabBar: false,
    splitAffordances: false,
    worktreeHistoryControls: false,
    // Nav entries whose destinations move into the console or the Fleet menu.
    'nav.tasks': false,
    'nav.automations': false,
    'nav.mobile': false,
    // Two competing fleet surfaces would be worse than one (§8.6).
    'view.activity': false,
    // Kept ON deliberately: `rightSidebar.checks` is the only signal that can
    // contradict a worker (§8.4).
    featureTips: false,
    contextualTours: false
  },
  capsules: {
    'workspace-body': 'alab.mission-control',
    'left-sidebar-body': 'alab.mission-strip'
  },
  styleVariables: undefined,
  copyKeyRemap: null,
  appIcon: DEFAULT_APP_ICON_ID,
  appMenuLabelSuffix: 'ALab',
  errorBoundarySurface: 'workspace-shell'
}

/**
 * Story World — a three-band stage for a child (§7).
 *
 * The most subtractive mode: no status bar, no right sidebar, no tabs, no
 * devtools, and `deepLink.runCommand` off because suppressing the command is
 * safer than softening its consent dialog, which §10.7 forbids.
 *
 * `styleVariables` remaps only authored tokens (§9.2): one `--radius`
 * reassignment rounds every Card/Button/Input because `@theme inline` inlines
 * the calc into the utility. Font scale is a documented addition that landed
 * with the design-token work.
 */
export const STORY_WORLD_MANIFEST: AppModeManifest = {
  manifestVersion: 1,
  id: 'story-world',
  labelKey: 'appMode.storyWorld',
  descriptionKey: 'appMode.storyWorldDescription',
  surfaces: {
    ...buildSurfaceRecord(false),
    // The only surfaces a child-facing stage keeps. Everything else is off, so
    // this list IS the mode's reach and can be read at a glance.
    browserPaneChrome: false,
    floatingTerminal: false
  },
  capsules: {
    'workspace-body': 'story-world.stage',
    'left-sidebar-body': 'story-world.worlds-list',
    'titlebar-strip': 'story-world.strip-header'
  },
  styleVariables: {
    '--radius': '1rem',
    '--app-font-scale': '1.15'
  },
  copyKeyRemap: null,
  appIcon: DEFAULT_APP_ICON_ID,
  appMenuLabelSuffix: 'Story World',
  errorBoundarySurface: 'workspace-shell'
}

export const APP_MODE_REGISTRY: Readonly<Record<AppModeId, AppModeManifest>> = {
  classic: CLASSIC_MANIFEST,
  alab: ALAB_MANIFEST,
  'story-world': STORY_WORLD_MANIFEST
}
