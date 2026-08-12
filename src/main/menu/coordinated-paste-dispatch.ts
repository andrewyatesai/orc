import { BrowserWindow, Menu } from 'electron'

/**
 * Routes the Edit > Paste menu command to whichever surface owns the caret.
 *
 * A focused BrowserWindow means an Orca pane owns paste — a terminal or native-chat pane
 * is not a native editable control, so raw Electron paste cannot know which surface owns
 * it, and the renderer resolves ownership from `ui:appMenuPaste`.
 *
 * With no focused window a macOS native panel (open/save, Go to Folder) is in front, so
 * hand paste to the first responder — overriding the paste role would strand Cmd+V there.
 */
export function dispatchCoordinatedPaste(isMac: boolean): void {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  if (focusedWindow) {
    focusedWindow.webContents.send('ui:appMenuPaste')
    return
  }

  if (isMac) {
    Menu.sendActionToFirstResponder('paste:')
  }
}
