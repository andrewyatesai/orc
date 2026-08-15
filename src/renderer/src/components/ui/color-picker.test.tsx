import '@/lib/git-wasm/init-git-wasm-for-test'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ColorPicker } from './color-picker'

describe('ColorPicker', () => {
  it('renders a normalized custom color trigger', () => {
    const html = renderToStaticMarkup(
      <ColorPicker value="#ABCDEF" onChange={vi.fn()} label="Custom repo color" />
    )

    expect(html).toContain('aria-label="Custom repo color"')
    expect(html).toContain('#abcdef')
    // The counterpart to color-picker.core-unavailable.test.tsx: the freeze is
    // conditional on the repo-badge-color core, not a permanent disable.
    // (`disabled=""`, not `disabled` — the Button class list carries
    // `disabled:pointer-events-none` variants either way.)
    expect(html).not.toContain('disabled=""')
  })
})
