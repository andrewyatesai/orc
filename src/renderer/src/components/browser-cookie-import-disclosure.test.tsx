/**
 * @vitest-environment happy-dom
 *
 * STA-3811: cookie imports never carry Google logins, so the import menus render a persistent,
 * non-interactive footer disclosing it and pointing the user at direct Google sign-in.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'

vi.mock('@/components/ui/dropdown-menu', () => {
  const block = ({ children }: { children?: ReactNode }): ReactNode => <div>{children}</div>
  return {
    DropdownMenuLabel: ({ children }: { children?: ReactNode }): ReactNode => (
      <div data-testid="dropdown-menu-label">{children}</div>
    ),
    DropdownMenuSeparator: (): ReactNode => <hr />,
    DropdownMenuContent: block,
    DropdownMenuItem: block
  }
})

import { BrowserCookieImportDisclosure } from './BrowserCookieImportDisclosure'

const DISCLOSURE_TITLE = "Google logins aren't imported"
const DISCLOSURE_DESCRIPTION = 'Sign in to Google directly in Orca.'

describe('BrowserCookieImportDisclosure', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders the localized title and description', () => {
    act(() => root.render(<BrowserCookieImportDisclosure />))

    expect(container.textContent).toContain(DISCLOSURE_TITLE)
    expect(container.textContent).toContain(DISCLOSURE_DESCRIPTION)
  })

  it('renders the icon and separator as non-interactive footer chrome', () => {
    act(() => root.render(<BrowserCookieImportDisclosure />))

    const label = container.querySelector('[data-testid="dropdown-menu-label"]')
    expect(label?.querySelector('svg')).not.toBeNull()
    expect(label?.previousElementSibling?.tagName).toBe('HR')
  })

  it('reads the footer copy from the catalog', () => {
    expect(en.auto.components.BrowserCookieImportDisclosure.title).toBe(DISCLOSURE_TITLE)
    expect(en.auto.components.BrowserCookieImportDisclosure.description).toBe(
      DISCLOSURE_DESCRIPTION
    )
  })
})
