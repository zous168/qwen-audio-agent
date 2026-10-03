import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Load the selected server-side RTC SDK bridge at process startup.
 *
 * The bridge is intentionally outside the repository because ARTC, TRTC,
 * Agora, and Volcengine ship different native/browser SDKs. The loaded module
 * must export:
 *
 *   openViduRtcBridge({ rtcInfo, live, liveId, signal, onAudio, onVideo })
 *
 * onAudio receives `{ data: Buffer, sampleRate: number }` or a Buffer. onVideo
 * receives `{ data: Uint8Array, width, height, format: 'I420' }`.
 */
export async function loadViduRtcBridgeFactory(environment = process.env, { cwd = process.cwd() } = {}) {
  const moduleName = String(environment.VIDU_RTC_BRIDGE_MODULE || '').trim()
  if (!moduleName) return null
  const path = isAbsolute(moduleName) ? moduleName : resolve(cwd, moduleName)
  const loaded = await import(pathToFileURL(path).href)
  const factory = loaded.openViduRtcBridge || loaded.default
  if (typeof factory !== 'function') throw new TypeError('VIDU_RTC_BRIDGE_MODULE must export openViduRtcBridge()')
  return factory
}
