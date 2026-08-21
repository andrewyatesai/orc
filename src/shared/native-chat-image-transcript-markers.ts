import { isTextBlock, type NativeChatBlock, type NativeChatMessage } from './native-chat-types'

const IMAGE_SOURCE_MARKER = /^\[Image:\s*source:\s*(.+?)\]\s*$/
const IMAGE_PROMPT_MARKER = /^\[Image #\d+\]\s*/

function soleText(message: NativeChatMessage): string | null {
  return message.blocks.length === 1 && isTextBlock(message.blocks[0])
    ? message.blocks[0].text
    : null
}

export function imageSourcePathFromText(text: string): string | null {
  return text.match(IMAGE_SOURCE_MARKER)?.[1]?.trim() ?? null
}

export function stripImagePromptMarker(text: string): string {
  return text.replace(IMAGE_PROMPT_MARKER, '')
}

// Returns the same blocks array when the first text block carries no marker, so
// an untouched row stays reference-stable through the live render pipeline.
function stripFirstImagePromptMarker(blocks: readonly NativeChatBlock[]): NativeChatBlock[] {
  const textIndex = blocks.findIndex(isTextBlock)
  const block = textIndex === -1 ? undefined : blocks[textIndex]
  if (!block || !isTextBlock(block)) {
    return blocks as NativeChatBlock[]
  }
  const text = stripImagePromptMarker(block.text)
  if (text.trim().length === 0) {
    return blocks.filter((_, index) => index !== textIndex)
  }
  if (text === block.text) {
    return blocks as NativeChatBlock[]
  }
  const next = [...blocks]
  next[textIndex] = { ...block, text }
  return next
}

function imagePromptMarkerStartsMessage(message: NativeChatMessage): boolean {
  const firstText = message.blocks.find(isTextBlock)
  return firstText ? IMAGE_PROMPT_MARKER.test(firstText.text) : false
}

/** Claude records an attached image as two user transcript turns:
 *  `[Image: source: /path]` and then `[Image #1] prompt`. Merge them back into
 *  one native turn so the UI keeps the same chip+text shape as the optimistic
 *  send and does not show raw TUI marker text after a view remount. */
export function normalizeImageTranscriptMessages(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  // Allocate lazily: an all-untouched transcript returns the same array so the
  // live render pipeline can reuse it by reference (the common hot path).
  let normalized: NativeChatMessage[] | null = null
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role !== 'user') {
      normalized?.push(message)
      continue
    }
    const imagePath = imageSourcePathFromText(soleText(message) ?? '')
    const next = messages[index + 1]
    if (
      imagePath &&
      next?.role === 'user' &&
      next.source === message.source &&
      imagePromptMarkerStartsMessage(next)
    ) {
      normalized ??= messages.slice(0, index)
      normalized.push({
        ...next,
        blocks: [
          { type: 'image-ref', path: imagePath },
          ...stripFirstImagePromptMarker(next.blocks)
        ]
      })
      index += 1
      continue
    }
    // A lone `[Image: source: /path]` turn (no following `[Image #1]` prompt —
    // e.g. an image sent with no caption) still renders as an image chip rather
    // than the raw marker text.
    if (imagePath) {
      normalized ??= messages.slice(0, index)
      normalized.push({
        ...message,
        blocks: [{ type: 'image-ref', path: imagePath }]
      })
      continue
    }
    const blocks = stripFirstImagePromptMarker(message.blocks)
    if (blocks === message.blocks) {
      normalized?.push(message)
    } else {
      normalized ??= messages.slice(0, index)
      normalized.push({ ...message, blocks })
    }
  }
  return normalized ?? (messages as NativeChatMessage[])
}
