import { loadConfiguredViduDigitalHuman } from '../voice/digital-human/vidu-runtime.mjs'

// The optional Vidu renderer is assembled by the same Gateway entry point as
// every other qwen-audio-agent capability. The adapter remains lazy, so a
// normal audio-only install does not need any Vidu or RTC bridge package.
const digitalHuman = await loadConfiguredViduDigitalHuman()
const { createGatewayApplication } = await import('./gateway-application.mjs')
const application = createGatewayApplication({ digitalHuman })

export const app = application.app
export const server = application.server
export const services = application.services
export const start = application.start
export const close = application.close
