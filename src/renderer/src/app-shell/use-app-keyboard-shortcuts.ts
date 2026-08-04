import { useEffect, useRef, type RefObject } from 'react'
import { registerAppCommandDispatcher } from '@/lib/app-command-dispatch'
import {
  ModifierDoubleTapDetector,
  toModifierDoubleTapEvent
} from '../../../shared/modifier-double-tap-detector'
import { usePluginCommands } from '../store/plugin-panels'
import { createAppCommandHandlers } from './app-command-handlers'
import { dispatchAppShortcut, type AppShortcutState } from './app-shortcut-dispatch'

// Window key listeners are global and long-lived: one registration, but the handler reads current shortcut state each key event.
export function useAppKeyboardShortcuts(stateRef: RefObject<AppShortcutState>): void {
  // Why here: plugin chords are a keyboard-dispatch input, and this call is also what loads the
  // plugin list, so the feature can't go inert by a caller forgetting to pass it.
  const pluginCommands = usePluginCommands()
  const pluginCommandsRef = useRef(pluginCommands)
  pluginCommandsRef.current = pluginCommands

  useEffect(() => {
    const doubleTapDetector = new ModifierDoubleTapDetector()
    // Lets a plugin palette / plugin alias invoke a built-in action through the same guarded handlers.
    const unregisterAppCommandDispatcher = registerAppCommandDispatcher((actionId) =>
      (createAppCommandHandlers(stateRef.current).get(actionId) ?? (() => false))()
    )

    const onKeyDown = (e: KeyboardEvent): void => {
      const detected = doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: 'keyDown',
          code: e.code,
          key: e.key,
          shift: e.shiftKey,
          control: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey,
          isAutoRepeat: e.repeat
        }),
        Date.now()
      )
      if (e.repeat) {
        return
      }
      if (detected) {
        // Synthetic input: no key/modifier flags, so only DoubleTap bindings match.
        dispatchAppShortcut(
          stateRef.current,
          {
            doubleTapModifier: detected.modifier,
            target: e.target,
            defaultPrevented: e.defaultPrevented,
            preventDefault: () => e.preventDefault()
          },
          pluginCommandsRef.current
        )
        return
      }
      dispatchAppShortcut(
        stateRef.current,
        {
          key: e.key,
          code: e.code,
          altKey: e.altKey,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          target: e.target,
          defaultPrevented: e.defaultPrevented,
          preventDefault: () => e.preventDefault()
        },
        pluginCommandsRef.current
      )
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      doubleTapDetector.process(
        toModifierDoubleTapEvent({
          type: 'keyUp',
          code: e.code,
          key: e.key,
          shift: e.shiftKey,
          control: e.ctrlKey,
          alt: e.altKey,
          meta: e.metaKey
        }),
        Date.now()
      )
    }

    // Why: a window blur mid-gesture must not leave the detector armed.
    const onBlur = (): void => doubleTapDetector.reset()

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('blur', onBlur)
    return () => {
      unregisterAppCommandDispatcher()
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('blur', onBlur)
    }
  }, [stateRef])
}
