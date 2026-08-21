// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./MobileBrandIcons', () => ({
  AndroidLogo: () => null,
  IosBrandIcon: () => null
}))

vi.mock('./NetworkInterfacePicker', () => ({
  NetworkInterfacePicker: () => null
}))

vi.mock('../settings/MobilePairingConnectionOptions', () => ({
  MobilePairingConnectionOptions: () => null
}))

vi.mock('./WindowsFirewallNotice', () => ({
  WindowsFirewallNotice: () => null
}))

import { HeroFlow, type StepIndex } from './MobileHero'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

describe('HeroFlow height', () => {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollHeight'
  )

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.textContent?.includes('Step 1 of 2') ? 300 : 520
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
    }
  })

  function renderFlow(
    stepIdx: StepIndex,
    overrides: Partial<React.ComponentProps<typeof HeroFlow>> = {}
  ) {
    return render(
      <HeroFlow
        stepIdx={stepIdx}
        platform="ios"
        onPlatformChange={vi.fn()}
        installQrUrl={null}
        installCopy={{ ctaLabel: 'Open TestFlight', url: 'https://example.com' }}
        iosChannel="preview"
        onIosChannelChange={vi.fn()}
        onOpenAndroidInstallGuide={vi.fn()}
        onOpenInstallUrl={vi.fn()}
        onCopyInstallUrl={vi.fn()}
        pairQrDataUrl={null}
        pairingUrl={null}
        relayDegraded={false}
        pairLoading={false}
        connectionMode="automatic"
        onConnectionModeChange={vi.fn()}
        onRegeneratePairing={vi.fn()}
        canGeneratePairing
        onCopyPairingCode={vi.fn()}
        networkInterfaces={[]}
        selectedAddress={undefined}
        onSelectedAddressChange={vi.fn()}
        onRefreshNetworkInterfaces={vi.fn()}
        refreshingNetworkInterfaces={false}
        onBack={vi.fn()}
        onContinue={vi.fn()}
        {...overrides}
      />
    )
  }

  it('sizes to the active step and updates when the taller pairing step opens', () => {
    const { rerender } = renderFlow(0)
    const viewport = document.querySelector<HTMLElement>('.mp-flow-viewport')
    expect(viewport).toHaveStyle({ height: '300px' })
    expect(screen.getByText('Step 2 of 2').closest('.mp-flow-screen')).toHaveAttribute('inert')

    rerender(
      <HeroFlow
        stepIdx={1}
        platform="ios"
        onPlatformChange={vi.fn()}
        installQrUrl={null}
        installCopy={{ ctaLabel: 'Open TestFlight', url: 'https://example.com' }}
        iosChannel="preview"
        onIosChannelChange={vi.fn()}
        onOpenAndroidInstallGuide={vi.fn()}
        onOpenInstallUrl={vi.fn()}
        onCopyInstallUrl={vi.fn()}
        pairQrDataUrl={null}
        pairingUrl={null}
        relayDegraded={false}
        pairLoading={false}
        connectionMode="automatic"
        onConnectionModeChange={vi.fn()}
        onRegeneratePairing={vi.fn()}
        canGeneratePairing
        onCopyPairingCode={vi.fn()}
        networkInterfaces={[]}
        selectedAddress={undefined}
        onSelectedAddressChange={vi.fn()}
        onRefreshNetworkInterfaces={vi.fn()}
        refreshingNetworkInterfaces={false}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />
    )

    expect(viewport).toHaveStyle({ height: '520px' })
    expect(screen.getByText('Step 1 of 2').closest('.mp-flow-screen')).toHaveAttribute('inert')
  })

  it('flags a degraded Anywhere code and always shows the Relay beta note', () => {
    renderFlow(1, {
      pairQrDataUrl: 'data:image/png;base64,qr',
      relayDegraded: true
    })
    const notice = screen.getByTestId('relay-degraded-notice')
    expect(notice).toHaveTextContent('only works on your LAN or Tailscale')
    // Why: wrap-capable text item inside the fixed QR track (#9700); bare text
    // nodes in a flex row cannot shrink below max-content and overflow the track.
    expect(notice.querySelector('.min-w-0')).not.toBeNull()
    expect(notice.className).toMatch(/\bmin-w-0\b/)
    expect(screen.getByText('Orca Relay is in beta.')).toBeInTheDocument()
  })

  it('hides the degradation notice when the code encodes what was selected', () => {
    renderFlow(1, { pairQrDataUrl: 'data:image/png;base64,qr' })
    expect(screen.queryByTestId('relay-degraded-notice')).not.toBeInTheDocument()
  })

  it('drives the pairing QR track off the encoder-reported natural bitmap size', () => {
    renderFlow(1, { pairQrDataUrl: 'data:image/png;base64,qr', pairQrSize: 218 })

    const image = screen.getByRole('img', { name: 'Pairing QR' })
    const layout = image.closest('.mp-pairing-layout') as HTMLElement
    // image = 218px natural bitmap; frame = image + 20px (10px padding each side).
    expect(layout.style.getPropertyValue('--mp-pairing-qr-image-size')).toBe('218px')
    expect(layout.style.getPropertyValue('--mp-pairing-qr-frame-size')).toBe('238px')
  })

  it('offers the APK install guide only on Android and links out on click', async () => {
    const user = userEvent.setup()
    const onOpenAndroidInstallGuide = vi.fn()

    // Guard: the link is Android-only — iOS install has no sideload step.
    renderFlow(0, { platform: 'ios' })
    expect(screen.queryByRole('button', { name: 'Install guide' })).not.toBeInTheDocument()
    cleanup()

    renderFlow(0, {
      platform: 'android',
      installCopy: {
        ctaLabel: 'Download upstream APK',
        url: 'https://example.com/app-release.apk'
      },
      onOpenAndroidInstallGuide
    })
    await user.click(screen.getByRole('button', { name: 'Install guide' }))
    expect(onOpenAndroidInstallGuide).toHaveBeenCalledOnce()
  })
})
