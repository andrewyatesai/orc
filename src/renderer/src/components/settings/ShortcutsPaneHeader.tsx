import React from 'react'
import type { KeybindingFileSnapshot } from '../../../../shared/keybindings'
import { KeybindingsFileActions } from './KeybindingsFileActions'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

// Pane header: title, keybindings-file path, file actions, and any snapshot
// diagnostics reported by the main process.
export function ShortcutsPaneHeader({
  keybindingSnapshot
}: {
  keybindingSnapshot: KeybindingFileSnapshot | null
}): React.JSX.Element {
  return (
    <>
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.ShortcutsPane.47f8f7aef9',
          'Keyboard Shortcuts'
        )}
        description={
          <>
            {translate(
              'auto.components.settings.ShortcutsPane.38e86e206a',
              'Customize shortcuts visually or edit'
            )}{' '}
            <span className="font-mono text-[11px]">
              {keybindingSnapshot?.path ??
                translate(
                  'auto.components.settings.ShortcutsPane.d8c988dab4',
                  '~/.orca/keybindings.json'
                )}
            </span>{' '}
            {translate('auto.components.settings.ShortcutsPane.4b7ae34062', 'directly.')}
          </>
        }
        action={<KeybindingsFileActions />}
      />

      {keybindingSnapshot?.diagnostics.length ? (
        <div className="space-y-1">
          {keybindingSnapshot.diagnostics.map((diagnostic, index) => (
            <p
              key={`${diagnostic.section ?? 'root'}-${diagnostic.actionId ?? index}`}
              className={
                diagnostic.severity === 'error'
                  ? 'text-xs text-destructive'
                  : 'text-xs text-muted-foreground'
              }
            >
              {diagnostic.message}
            </p>
          ))}
        </div>
      ) : null}
    </>
  )
}
