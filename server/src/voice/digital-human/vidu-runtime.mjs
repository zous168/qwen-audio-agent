import { fileURLToPath } from 'node:url'
import { requireWebRtcDependencies } from '../../../../shared/gateway/webrtc.mjs'

const VIDU_PROVIDER_ROOT = new URL('../../../../examples/vidu-digital-human/providers/vidu/', import.meta.url)

function disabledDigitalHuman(reason = 'not_configured') {
  return { available: false, reason, personas: () => [] }
}

/**
 * Assemble the optional Vidu adapter for the main Gateway process.
 *
 * Vidu is an optional renderer inside qwen-audio-agent. The vendor adapter is
 * loaded lazily so an audio-only installation has no dependency on Vidu or a
 * vendor RTC bridge. A configured bridge also enables the existing WebRTC
 * ingress because the avatar track is delivered over that same connection.
 */
export async function loadConfiguredViduDigitalHuman({
  environment = process.env,
  cwd,
  logger = console,
  requireRtc = requireWebRtcDependencies,
} = {}) {
  const apiKey = String(environment.VIDU_API_KEY || '').trim()
  const bridgeModule = String(environment.VIDU_RTC_BRIDGE_MODULE || '').trim()
  if (!apiKey && !bridgeModule) return disabledDigitalHuman()
  if (!apiKey) {
    logger?.warn?.('Vidu has an RTC bridge path but no VIDU_API_KEY; keeping audio-only mode.')
    return disabledDigitalHuman()
  }
  if (!bridgeModule) {
    logger?.warn?.('Vidu is configured without VIDU_RTC_BRIDGE_MODULE; keeping audio-only mode.')
    return disabledDigitalHuman()
  }

  try {
    const [{ loadViduConfig }, { createViduDigitalHuman }, { loadViduRtcBridgeFactory }] = await Promise.all([
      import(new URL('vidu-config.mjs', VIDU_PROVIDER_ROOT)),
      import(new URL('vidu-digital-human-provider.mjs', VIDU_PROVIDER_ROOT)),
      import(new URL('vidu-rtc-bridge.mjs', VIDU_PROVIDER_ROOT)),
    ])
    const config = loadViduConfig(environment)
    const mediaBridgeFactory = await loadViduRtcBridgeFactory(environment, {
      cwd: cwd || process.cwd(),
    })
    if (typeof mediaBridgeFactory !== 'function') {
      throw new Error('VIDU_RTC_BRIDGE_MODULE did not provide an RTC bridge factory')
    }

    // Check dependencies before advertising an available avatar. An invalid
    // optional renderer degrades locally without stopping the whole Gateway.
    requireRtc()
    environment.QWAUDIO_WEBRTC_ENABLED = '1'
    logger?.info?.(`Vidu digital-human adapter enabled (${config.rtcInfo.provider}).`)
    return createViduDigitalHuman({ config, mediaBridgeFactory, logger })
  } catch (error) {
    logger?.warn?.(`Vidu configuration is unavailable; keeping audio-only mode (${error.code || 'invalid_configuration'}).`)
    return disabledDigitalHuman('invalid_configuration')
  }
}

export const viduProviderRoot = fileURLToPath(VIDU_PROVIDER_ROOT)
