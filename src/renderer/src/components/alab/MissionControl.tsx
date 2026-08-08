/**
 * ALab's `workspace-body` capsule — the supervisory console
 * (`docs/reference/app-modes.md` §8.3).
 *
 * Three stacked bands, top to bottom in the order a supervisor reads them:
 *
 *   LandingBand      — work that is ready to review. Collapsed when empty.
 *   ExceptionsQueue  — everything that stopped and needs a human. Always mounted.
 *   FleetBoard       — who is doing what, and whether they are actually alive.
 *
 * `ExceptionsQueue` is always mounted, even when empty, because it is an
 * `aria-live` region: a queue that appears only once something is wrong cannot
 * announce the thing going wrong.
 *
 * This capsule replaces the centre region wholesale. It does NOT contain the
 * terminal workbench — `<Terminal/>` is a sibling in the main pane column and
 * stays mounted in every mode (§5.1), so the panes this console describes are
 * alive and one click away, not closed.
 */

import { translate } from '@/i18n/i18n'
import { ExceptionsQueue } from './ExceptionsQueue'
import { FleetBoard } from './FleetBoard'
import { LandingBand } from './LandingBand'

export default function MissionControl(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="alab-mission-control">
      <header className="shrink-0">
        <h1 className="text-sm font-semibold">{translate('alab.console.heading', 'Fleet')}</h1>
        <p className="text-[11px] text-muted-foreground">
          {/* States the posture rather than implying a boundary: ALab adds no
              sandbox, and §8.6 forbids any label suggesting otherwise. */}
          {translate(
            'alab.console.subheading',
            'Your files and diffs are hidden here, not closed. Nothing has been stopped.'
          )}
        </p>
      </header>

      {/* Collapsed when empty — it returns null rather than rendering a
          permanent "nothing to review" header. */}
      <LandingBand />

      {/* ~34% of the height, two-row minimum, always mounted (§8.3). */}
      <section className="min-h-[8rem] shrink-0 basis-[34%] overflow-hidden">
        <ExceptionsQueue />
      </section>

      <section className="min-h-0 flex-1 overflow-hidden">
        <FleetBoard />
      </section>
    </div>
  )
}
