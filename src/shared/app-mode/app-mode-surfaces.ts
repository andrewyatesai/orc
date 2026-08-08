/**
 * The surface vocabulary a mode may gate — **frozen by
 * `docs/reference/app-modes.md` §2.2**.
 *
 * This union is the shared contract: adding a member is a compile error in all
 * three manifests, and the membership itself is asserted by the neutrality test.
 * No mode may add a member unilaterally.
 *
 * **Surfaces are boolean, and there is no partial-surface vocabulary.** A mode
 * may not "reduce the status bar to two segments" — `statusBarItems` is a
 * user-configured list with its own migration flags, and silently filtering it
 * would be a mode overriding a user's choice. If a class of segment genuinely
 * needs gating it becomes its own member here, with the union-growth cost paid
 * openly.
 *
 * `view.settings` is deliberately ABSENT: settings reachability is structural
 * (§2.6), so no mode can gate itself out of the mode picker.
 */

export type AppSurfaceId =
  // Right sidebar
  | 'rightSidebar'
  | 'rightSidebar.explorer'
  | 'rightSidebar.sourceControl'
  | 'rightSidebar.checks'
  | 'rightSidebar.ports'
  | 'rightSidebar.agents'
  | 'rightSidebar.vault'
  // Workbench chrome
  | 'statusBar'
  | 'titlebarTabs'
  | 'tabBar'
  | 'splitAffordances'
  | 'worktreeHistoryControls'
  | 'floatingTerminal'
  // Left nav
  | 'nav.tasks'
  | 'nav.automations'
  | 'nav.mobile'
  | 'nav.agents'
  | 'nav.agentDashboard'
  | 'nav.setupGuide'
  // Top-level views (settings is deliberately NOT here — §2.6)
  | 'view.tasks'
  | 'view.activity'
  | 'view.automations'
  | 'view.space'
  | 'view.skills'
  | 'view.mobile'
  // Editing + panes
  | 'editorTabs'
  | 'diffSurfaces'
  | 'browserPaneChrome'
  // Shell entry points
  | 'devTools'
  | 'coordinatorWindow'
  | 'deepLink.runCommand'
  // Education
  | 'featureTips'
  | 'contextualTours'
  | 'featureWall'

/**
 * Every member, as data. The neutrality test asserts this list matches the union
 * exactly — a member added to the type but not here (or vice versa) fails there
 * rather than silently becoming an ungatable surface.
 */
export const APP_SURFACE_IDS: readonly AppSurfaceId[] = [
  'rightSidebar',
  'rightSidebar.explorer',
  'rightSidebar.sourceControl',
  'rightSidebar.checks',
  'rightSidebar.ports',
  'rightSidebar.agents',
  'rightSidebar.vault',
  'statusBar',
  'titlebarTabs',
  'tabBar',
  'splitAffordances',
  'worktreeHistoryControls',
  'floatingTerminal',
  'nav.tasks',
  'nav.automations',
  'nav.mobile',
  'nav.agents',
  'nav.agentDashboard',
  'nav.setupGuide',
  'view.tasks',
  'view.activity',
  'view.automations',
  'view.space',
  'view.skills',
  'view.mobile',
  'editorTabs',
  'diffSurfaces',
  'browserPaneChrome',
  'devTools',
  'coordinatorWindow',
  'deepLink.runCommand',
  'featureTips',
  'contextualTours',
  'featureWall'
]

/** Builds an exhaustive surface record. Exported so Classic's all-true table and
 *  the neutrality test are generated from one place and cannot drift. */
export function buildSurfaceRecord(value: boolean): Record<AppSurfaceId, boolean> {
  return Object.fromEntries(APP_SURFACE_IDS.map((id) => [id, value])) as Record<
    AppSurfaceId,
    boolean
  >
}
