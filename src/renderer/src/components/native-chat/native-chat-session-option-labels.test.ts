import { describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import { nativeChatSessionChoiceLabel } from './native-chat-session-option-labels'

vi.mock('@/i18n/i18n', () => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

describe('nativeChatSessionChoiceLabel', () => {
  it('routes ultra through the localized effort label', () => {
    nativeChatSessionChoiceLabel({ value: 'ultra', label: 'Ultra' })

    expect(translate).toHaveBeenCalledWith(
      'components.native-chat.composer.optionValue.ultra',
      'Ultra'
    )
  })

  it('falls through to the raw choice label for an unlocalized value', () => {
    // Plant a violation: an effort the switch never localizes must keep its own label.
    expect(nativeChatSessionChoiceLabel({ value: 'future-effort', label: 'Future' })).toBe('Future')
  })
})
