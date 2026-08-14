import type { OpenFile } from '@/store/slices/editor'

// Why: a markdown-preview tab fronts the same document as its source editor, so
// a save must resolve to the underlying editable file, not the read-only preview.
export function getEditorSaveTargetFile(
  activeFile: OpenFile,
  openFiles: OpenFile[]
): OpenFile | null {
  if (activeFile.mode !== 'markdown-preview') {
    return activeFile
  }
  return (
    openFiles.find(
      (openFile) =>
        openFile.id === activeFile.markdownPreviewSourceFileId && openFile.mode === 'edit'
    ) ?? null
  )
}
