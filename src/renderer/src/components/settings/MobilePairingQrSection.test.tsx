// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// Render dialog/button children plainly so both the inline and enlarged QR
// images are in the tree for a document-wide style assertion.
vi.mock('../ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('../ui/button', () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>
}))

import { MobilePairingQrSection } from './MobilePairingQrSection'

afterEach(() => cleanup())

function qrImages(): HTMLImageElement[] {
  return Array.from(
    document.querySelectorAll<HTMLImageElement>('img[alt="QR Code for mobile pairing"]')
  )
}

describe('MobilePairingQrSection scanner-safe scaling', () => {
  it('paints the QR at its natural size and an integer 2x enlargement, pixelated', () => {
    render(
      <MobilePairingQrSection
        qrDataUrl="data:image/png;base64,qr"
        qrSize={218}
        pairingUrl="orca://pair#ready"
        endpoint={null}
        qrEnlarged
        codeCopied={false}
        onQrEnlargedChange={vi.fn()}
        onCodeCopiedChange={vi.fn()}
        onClearCodeCopiedTimer={vi.fn()}
      />
    )

    const images = qrImages()
    expect(images.map((image) => image.style.width).sort()).toEqual(['218px', '436px'])
    expect(images.map((image) => image.style.height).sort()).toEqual(['218px', '436px'])
    expect(images.every((image) => image.style.imageRendering === 'pixelated')).toBe(true)
  })

  it('falls back to fixed 192/288px sizes when the encoder reports no size', () => {
    render(
      <MobilePairingQrSection
        qrDataUrl="data:image/png;base64,qr"
        qrSize={null}
        pairingUrl="orca://pair#ready"
        endpoint={null}
        qrEnlarged
        codeCopied={false}
        onQrEnlargedChange={vi.fn()}
        onCodeCopiedChange={vi.fn()}
        onClearCodeCopiedTimer={vi.fn()}
      />
    )

    expect(qrImages().map((image) => image.style.width).sort()).toEqual(['192px', '288px'])
  })
})
