// Preserves the phone-local previews of a sent photo after its optimistic bubble
// is reconciled away: binds each preview to the authoritative transcript turn its
// echo claimed, so the `[Image: source: …]` marker turn (which only carries the
// host path) can still render the local image. Pure — no React, no I/O.

const SENT_IMAGE_PREVIEW_LIMIT = 32
const SENT_IMAGE_PREVIEW_SESSION_LIMIT = 8

/** A landed image echo's local URIs, keyed by the message id its echo claimed. */
export type ImagePreviewBinding = [messageId: string, images: string[]]

// A captioned send folds into one prompt turn that carries every photo; an
// image-only send echoes one `[Image: source: …]` turn per photo, so each preview
// binds to its own turn (in send order).
export function imagePreviewBindings(
  entry: { normalizedText: string; images?: string[] },
  claimedMessageIds: readonly string[]
): ImagePreviewBinding[] {
  const images = entry.images
  if (!images?.length || claimedMessageIds.length === 0) {
    return []
  }
  if (entry.normalizedText !== '') {
    const firstId = claimedMessageIds[0]
    return firstId ? [[firstId, [...images]]] : []
  }
  const bindings: ImagePreviewBinding[] = []
  claimedMessageIds.forEach((messageId, index) => {
    const uri = images[index]
    if (uri !== undefined) {
      bindings.push([messageId, [uri]])
    }
  })
  return bindings
}

// Accumulates bindings into the session's message-keyed map, re-inserting the
// active session last and capping both photos and sessions so a long-lived route
// can't retain every phone URI it ever sent.
export function mergeLandedImagePreviews(
  previous: Record<string, Record<string, string[]>>,
  sessionKey: string,
  bindings: readonly ImagePreviewBinding[]
): Record<string, Record<string, string[]>> {
  const entries = Object.entries(previous[sessionKey] ?? {})
  for (const [messageId, images] of bindings) {
    const existingIndex = entries.findIndex(([id]) => id === messageId)
    if (existingIndex !== -1) {
      entries.splice(existingIndex, 1)
    }
    entries.push([messageId, images])
  }
  const next = { ...previous }
  delete next[sessionKey]
  next[sessionKey] = Object.fromEntries(entries.slice(-SENT_IMAGE_PREVIEW_LIMIT))
  for (const key of Object.keys(next).slice(0, -SENT_IMAGE_PREVIEW_SESSION_LIMIT)) {
    delete next[key]
  }
  return next
}
