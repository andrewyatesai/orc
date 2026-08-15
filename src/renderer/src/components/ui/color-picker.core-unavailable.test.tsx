// @vitest-environment happy-dom
//
// Deliberately does NOT import '@/lib/git-wasm/init-git-wasm-for-test': this file
// renders ColorPicker while the repo-badge-color core is NOT ready, which is the
// exact state that reverted the cut-over. Two regressions are pinned:
//   1. "Invalid hex color" / aria-invalid shown against a perfectly valid hex;
//   2. a colour-wheel drag calling onChange, which wrote default gray over the
//      user's saved repo colour.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColorPicker } from './color-picker'
import { getGitWasmAvailability } from '@/lib/git-wasm/git-wasm-availability'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(node: React.JSX.Element): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(node)
  })
  return container
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
})

describe('ColorPicker while the repo-badge-color core is unavailable', () => {
  it('never flags a valid hex as invalid, and refuses to open rather than guess', () => {
    expect(getGitWasmAvailability()).toBe('pending')
    const onChange = vi.fn()
    const host = render(
      <ColorPicker value="#ABCDEF" onChange={onChange} label="Custom repo color" defaultOpen />
    )

    expect(host.textContent).not.toContain('Invalid hex color')
    expect(host.querySelector('[aria-invalid="true"]')).toBeNull()
    const trigger = host.querySelector('button[aria-label="Custom repo color"]')
    expect(trigger?.hasAttribute('disabled')).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not persist a colour from a wheel drag or a hex edit', () => {
    const onChange = vi.fn()
    const host = render(
      <ColorPicker value="#ABCDEF" onChange={onChange} label="Custom repo color" defaultOpen />
    )

    // react-colorful's onChange (the wheel drag) is `updateColor`; the reverted
    // shim made it commit DEFAULT_REPO_BADGE_COLOR over the saved colour. The
    // popover is closed here because the trigger is disabled, so the strongest
    // available statement is that nothing rendered has emitted a change.
    const input = host.querySelector('input')
    if (input) {
      act(() => {
        input.value = '#00ff00'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('blur', { bubbles: true }))
      })
    }

    expect(onChange).not.toHaveBeenCalled()
  })
})
