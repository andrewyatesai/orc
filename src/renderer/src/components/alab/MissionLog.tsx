/**
 * Why the fleet did what it did — `docs/reference/app-modes.md` §8.4.
 *
 * The exceptions queue structurally cannot answer this: every lane in it is a
 * pre-failure or at-failure signal, so it says what is wrong NOW and nothing
 * about how the run arrived there. The coordinator's own diagnostic stream is
 * the record of that, and before R0 it was written into a no-op.
 *
 * Read on demand rather than polled: a supervisor opens the log when something
 * has already gone wrong, and streaming it every two seconds would spend the
 * long-poll budget the fleet's workers need on a panel nobody is reading.
 */

import { useCallback, useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'

export type MissionLogProps = {
  runId: string
}

export function MissionLog({ runId }: MissionLogProps): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await window.api.runtime.call({
        method: 'orchestration.runLog',
        params: { run: runId }
      })
      if (!response.ok) {
        throw new Error('runLog failed')
      }
      const entries = (response.result as { entries?: { message?: string }[] })?.entries ?? []
      setLines(entries.map((entry) => entry.message ?? ''))
      setError(false)
    } catch {
      setError(true)
    }
  }, [runId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex flex-col gap-1" data-testid="alab-mission-log">
      <h3 className="text-[11px] font-medium text-muted-foreground">
        {translate('alab.log.heading', 'What happened')}
      </h3>
      {error ? (
        <p className="text-[11px] text-destructive" role="status">
          {translate('alab.log.unavailable', 'Cannot read the log for this run.')}
        </p>
      ) : lines.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {/* The ring is per-run and in-memory, so a restart genuinely loses it —
              said plainly rather than shown as an empty, healthy-looking log. */}
          {translate('alab.log.empty', 'No log for this run. A restart clears it.')}
        </p>
      ) : (
        <ol className="flex flex-col gap-0.5 text-[11px]">
          {lines.map((line, index) => (
            <li key={`${index}-${line}`} className="font-mono">
              {line}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
