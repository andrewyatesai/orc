import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import type { AskPrompt } from './mobile-native-chat-ask'

// react-native's StyleSheet.create is an identity passthrough here so the raw
// style objects reach the rendered nodes and can be asserted.
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ Check: 'Check' }))

type Flat = Record<string, unknown>

// RN style props are arrays that may nest arrays and falsey conditionals.
function flatten(style: unknown): Flat {
  if (Array.isArray(style)) {
    return style.reduce<Flat>((acc, entry) => ({ ...acc, ...flatten(entry) }), {})
  }
  if (style && typeof style === 'object') {
    return style as Flat
  }
  return {}
}

const prompt: AskPrompt = {
  questions: [
    {
      question: 'Pick one',
      multiSelect: false,
      options: [{ label: 'First' }, { label: 'Second', description: 'Second choice' }]
    }
  ]
}

function suppressDeprecationWarning(): () => void {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const first = args[0]
    if (typeof first === 'string' && first.includes('react-test-renderer is deprecated')) {
      return
    }
    original(...args)
  })
  return () => spy.mockRestore()
}

async function render(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  const restore = suppressDeprecationWarning()
  try {
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatAsk, { prompt, onAnswer: async () => true })
      )
      await Promise.resolve()
    })
  } finally {
    restore()
  }
  return renderer!
}

describe('MobileNativeChatAsk checkmark centering (#12565)', () => {
  it('centers each option row against its checkmark', async () => {
    const renderer = await render()
    const optionRows = renderer.root
      .findAll((node) => node.type === 'Pressable')
      .map((node) => flatten(node.props.style))
      .filter((s) => s.flexDirection === 'row' && 'marginBottom' in s && 'padding' in s)

    // Two options + the "Other…" row.
    expect(optionRows.length).toBe(3)
    for (const row of optionRows) {
      expect(row.alignItems).toBe('center')
    }
  })

  it('drops the marginTop nudge from the checkmark box', async () => {
    const renderer = await render()
    const checks = renderer.root
      .findAll((node) => node.type === 'View')
      .map((node) => flatten(node.props.style))
      .filter((s) => s.width === 18 && s.height === 18)

    expect(checks.length).toBeGreaterThan(0)
    for (const check of checks) {
      expect(check.marginTop).toBeUndefined()
      expect(check.alignItems).toBe('center')
      expect(check.justifyContent).toBe('center')
    }
  })
})
