import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { RuntimeAccessGrant } from '../../shared/runtime-access-grants'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import {
  getDefaultPairingAddress,
  listPairingNetworkInterfaces,
  type NetworkInterface
} from './mobile-pairing-interfaces'
import type { DeviceEntry } from '../runtime/device-registry'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../runtime/network-exposure-guidance'
import {
  isLoopbackPairingHostname,
  resolveAdvertisedPairingHostname
} from '../runtime/pairing-endpoint'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { RelayBrokerStatus } from '../runtime/relay/relay-session-broker'
import {
  getWebSocketPort,
  inspectWindowsMobileFirewall,
  repairWindowsMobileFirewall,
  type WindowsMobileFirewallEnvironment
} from '../runtime/windows-mobile-firewall'

// Enumeration (IPv4 + non-link-local IPv6, tailnet-first ranking) lives in
// ./mobile-pairing-interfaces so the serve/headless path can reuse it.
export type { NetworkInterface }

// Scanner-safe pairing QR geometry: render at an integer pixels-per-module
// pitch (2px) with a spec-standard 4-module quiet zone so the bitmap scales
// crisply. A fixed 256px width forced non-integer module scaling on the larger
// Relay-sized symbols (blurry, scanner-hostile); the natural size below travels
// to the renderer, which paints it 1:1 (or an integer multiple) with pixelated.
const PAIRING_QR_QUIET_ZONE_MODULES = 4
const PAIRING_QR_MODULE_PITCH_PX = 2

// Why: only an explicit "This computer only" pick skips the one-way widen, and only when the address it
// advertises really is loopback — a mismatch (a LAN address under a this-computer reach) would otherwise
// mint a link with no listener behind it. Every other reach, including a loopback-looking Custom address
// that fronts an SSH tunnel or reverse proxy, still opts in.
function servesThisComputerOnly(reach: RuntimePairingReach | undefined, address: string): boolean {
  if (reach !== 'this-computer') {
    return false
  }
  const hostname = resolveAdvertisedPairingHostname(address)
  return hostname !== null && isLoopbackPairingHostname(hostname)
}

function toRuntimeAccessGrant(device: DeviceEntry): RuntimeAccessGrant {
  return {
    deviceId: device.deviceId,
    name: device.name,
    createdAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt > 0 ? device.lastSeenAt : null
  }
}

// Why: the mobile IPC handlers provide the renderer with QR code pairing data,
// device management, and WebSocket readiness status. They depend on the
// OrcaRuntimeRpcServer because it owns the device registry and TLS state.

export type MobileHandlerDependencies = {
  firewallEnvironment?: WindowsMobileFirewallEnvironment
  openWindowsNetworkSettings?: () => Promise<void>
  getRelayStatus?: () => RelayBrokerStatus
  consumePendingUnpairedDeviceAuthFailure?: (webContentsId: number) => boolean
}

export function registerMobileHandlers(
  rpcServer: OrcaRuntimeRpcServer,
  dependencies: MobileHandlerDependencies = {}
): void {
  const firewallEnvironment = dependencies.firewallEnvironment ?? {
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
    systemRoot: process.env.SystemRoot
  }
  ipcMain.handle('mobile:listNetworkInterfaces', (): { interfaces: NetworkInterface[] } => ({
    interfaces: listPairingNetworkInterfaces()
  }))

  ipcMain.handle(
    'mobile:getPairingQR',
    async (
      _event,
      args?: {
        address?: string
        connectionMode?: MobilePairingConnectionMode
        rotate?: boolean
      }
    ) => {
      // Why: allow the caller to specify which network interface address to
      // embed in the QR code. This supports overlay networks (Tailscale,
      // ZeroTier) where the default LAN IP isn't reachable from the phone.
      const ip = args?.address ?? getDefaultPairingAddress()
      // Why: the local address is optional under Relay — the QR carries the relay invite, so a host
      // with nothing auto-advertisable (only container bridges, or no interface at all) still pairs;
      // the offer's endpoint then falls back to loopback, which is the scanning phone's own device, so
      // the direct candidate loses the race by construction. LAN-only has no relay to fall back on, so
      // it fails closed rather than advertising a bridge the phone cannot reach.
      if (!ip && args?.connectionMode === 'local-only') {
        return { available: false as const }
      }

      // Why: coalesce repeated QR regenerations onto a single never-scanned
      // pending token so the copy-button flow doesn't accumulate orphaned
      // device credentials forever. The token graduates to a real entry when
      // a phone actually connects (lastSeenAt > 0). When the caller passes
      // `rotate: true` (explicit "Regenerate" intent because the prior token
      // may have been exposed), we discard any pending token and mint a fresh
      // one so the new QR carries a different credential.
      const offer = await rpcServer.createMobilePairingOffer({
        address: ip,
        connectionMode: args?.connectionMode,
        rotate: args?.rotate,
        name: `Mobile ${new Date().toLocaleDateString()}`
      })
      if (!offer.available) {
        return { available: false as const }
      }

      // Why dynamic: pairing is the only consumer, so launch should not parse
      // the qrcode bundle for users who never pair a device.
      const { default: QRCode } = await import('qrcode')
      // Why: the module count drives the natural bitmap size the renderer paints
      // at, so scan it once at the same error-correction level the bitmap uses.
      const qrModuleCount = QRCode.create(offer.pairingUrl, {
        errorCorrectionLevel: 'M'
      }).modules.size
      const qrSize =
        (qrModuleCount + PAIRING_QR_QUIET_ZONE_MODULES * 2) * PAIRING_QR_MODULE_PITCH_PX
      const qrDataUrl = await QRCode.toDataURL(offer.pairingUrl, {
        errorCorrectionLevel: 'M',
        margin: PAIRING_QR_QUIET_ZONE_MODULES,
        scale: PAIRING_QR_MODULE_PITCH_PX
      })

      return {
        available: true as const,
        qrDataUrl,
        qrSize,
        pairingUrl: offer.pairingUrl,
        // Why: with nothing advertised the offer's endpoint is the loopback fallback, which points at
        // whichever device scans the QR — never this host. Report no endpoint so the UI omits it
        // instead of printing an address the phone can't reach.
        endpoint: ip ? offer.endpoint : null,
        deviceId: offer.deviceId,
        // Why: an automatic request can degrade to a local-only offer when
        // Relay provisioning fails; the UI needs the encoded mode to avoid
        // labeling a LAN-only code as Relay.
        connectionMode: offer.connectionMode
      }
    }
  )

  ipcMain.handle(
    'mobile:getRuntimePairingUrl',
    async (_event, args?: { address?: string; rotate?: boolean; reach?: RuntimePairingReach }) => {
      const ip = args?.address ?? getDefaultPairingAddress()
      if (!ip) {
        return { available: false as const }
      }

      // Why: STA-2370 — generating a runtime pairing offer is the user's explicit opt-in to remote
      // reach, so widen the loopback listener before advertising its LAN endpoint. If the widen fails the
      // listener stays on loopback, so report unavailable rather than advertise a dead LAN endpoint.
      // "This computer only" is the opposite opt-in: the loopback listener already serves it, and the widen
      // never narrows back, so that pick alone must not expose the runtime off-host.
      const thisComputerOnly = servesThisComputerOnly(args?.reach, ip)
      if (!thisComputerOnly) {
        try {
          await rpcServer.ensureNetworkExposure()
        } catch (error) {
          console.error(
            '[mobile] Network exposure failed while creating a runtime pairing offer:',
            error
          )
          // Why: STA-2370 — carry the specific reason/guidance to the renderer (mirrors the mobile-QR path) so
          // a widen failure is distinguishable from a missing address, not collapsed into a bare unavailable.
          return {
            available: false as const,
            reason: 'network_exposure_failed' as const,
            guidance: NETWORK_EXPOSURE_FAILED_GUIDANCE
          }
        }
      }

      // Why: web/desktop runtime clients need full runtime access, not the
      // mobile allowlist used by phone QR pairing.
      const offer = await rpcServer.createPairingOffer({
        address: ip,
        rotate: args?.rotate,
        name: `Runtime ${new Date().toLocaleDateString()}`,
        scope: 'runtime',
        // Why: a grant that only ever pointed at loopback must not make the next launch bind every
        // interface when its local client reconnects (that would restore the exposure one restart later).
        reach: thisComputerOnly ? 'this-computer' : 'network'
      })
      if (!offer.available) {
        return { available: false as const }
      }

      return {
        available: true as const,
        pairingUrl: offer.pairingUrl,
        webClientUrl: offer.webClientUrl,
        endpoint: offer.endpoint,
        deviceId: offer.deviceId
      }
    }
  )

  ipcMain.handle('mobile:listDevices', () => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { devices: [] }
    }
    // Why: devices with lastSeenAt === 0 were created during QR generation
    // but never actually scanned/connected. Showing them as "paired" is
    // misleading, so we filter them out.
    return {
      devices: registry
        .listDevices()
        .filter((d) => d.scope === 'mobile' && d.lastSeenAt > 0)
        .map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          pairedAt: d.pairedAt,
          lastSeenAt: d.lastSeenAt
        }))
    }
  })

  ipcMain.handle('mobile:listRuntimeAccessGrants', () => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { grants: [] }
    }
    // Why: generated web/runtime links are bearer credentials even before a
    // client first connects, so pending runtime grants must stay revocable.
    return {
      grants: registry
        .listDevices()
        .filter((d) => d.scope === 'runtime')
        .sort((a, b) => b.pairedAt - a.pairedAt)
        .map(toRuntimeAccessGrant)
    }
  })

  ipcMain.handle('mobile:revokeDevice', async (_event, args: { deviceId: string }) => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { revoked: false }
    }
    return { revoked: await rpcServer.revokeMobileDevice(args.deviceId) }
  })

  ipcMain.handle('mobile:revokeRuntimeAccess', (_event, args: { deviceId: string }) => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { revoked: false }
    }
    return { revoked: rpcServer.revokeRuntimeAccess(args.deviceId) }
  })

  ipcMain.handle('mobile:isWebSocketReady', () => {
    return {
      ready: rpcServer.getWebSocketEndpoint() !== null,
      endpoint: rpcServer.getWebSocketEndpoint()
    }
  })

  ipcMain.handle('mobile:getWindowsFirewallStatus', (_event, args?: { address?: string }) => {
    const port = getWebSocketPort(rpcServer.getWebSocketEndpoint())
    return inspectWindowsMobileFirewall(port, args?.address, firewallEnvironment)
  })

  ipcMain.handle('mobile:repairWindowsFirewall', (event: IpcMainInvokeEvent) => {
    if (!isWindowRenderer(event)) {
      return { ok: false as const, reason: 'unsupported' as const }
    }
    // Why: elevated inputs come from the running runtime, never the renderer.
    const port = getWebSocketPort(rpcServer.getWebSocketEndpoint())
    return repairWindowsMobileFirewall(port, firewallEnvironment)
  })

  ipcMain.handle('mobile:openWindowsNetworkSettings', async (event: IpcMainInvokeEvent) => {
    if (!isWindowRenderer(event) || firewallEnvironment.platform !== 'win32') {
      return false
    }
    const openSettings =
      dependencies.openWindowsNetworkSettings ??
      (() => shell.openExternal('ms-settings:network-status'))
    await openSettings()
    return true
  })

  ipcMain.handle('mobile:getRelayStatus', () => ({
    status: dependencies.getRelayStatus?.() ?? 'offline'
  }))

  ipcMain.handle('mobile:consumePendingUnpairedDeviceAuthFailure', (event) => {
    if (!isWindowRenderer(event)) {
      return false
    }
    return dependencies.consumePendingUnpairedDeviceAuthFailure?.(event.sender.id) ?? false
  })
}

function isWindowRenderer(event: IpcMainInvokeEvent): boolean {
  return !event.sender.isDestroyed() && event.sender.getType() === 'window'
}
