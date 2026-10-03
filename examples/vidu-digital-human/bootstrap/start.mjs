import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { loadConfiguredViduDigitalHuman } from '../../../server/src/voice/digital-human/vidu-runtime.mjs'

async function start() {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  process.env.QWAUDIO_WEBRTC_ENABLED = '1'
  process.env.QWEN_AUDIO_REALTIME_PROVIDER ||= 'dashscope'
  process.env.QWEN_AUDIO_REALTIME_MODEL ||= 'qwen-audio-3.0-realtime-plus'
  process.env.AGENT_PROTOCOL ||= 'none'
  process.env.QWAUDIO_CONFIG_DIR ||= fileURLToPath(new URL('../.runtime/config', import.meta.url))
  process.env.QWEN_AUDIO_AGENT_RUNTIME_ROOT ||= fileURLToPath(new URL('../.runtime', import.meta.url))
  const digitalHuman = await loadConfiguredViduDigitalHuman({
    cwd: fileURLToPath(new URL('../', import.meta.url)),
  })
  const { createGatewayApplication } = await import('../../../server/src/app/gateway-application.mjs')
  const application = createGatewayApplication({ autoStart: false, digitalHuman })
  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT || 3101)
  application.start({ host, port })
  if (!application.server.listening) await once(application.server, 'listening')
  console.log(`Vidu digital-human gateway: http://${host}:${port}`)
  console.log(`Digital human output: ${digitalHuman.available ? 'available' : 'audio-only (set VIDU_RTC_BRIDGE_MODULE)'}`)
  console.log('Open /api/realtime/webrtc/example')
  const shutdown = async () => {
    await application.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return application
}

const invokedDirectly = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])

if (invokedDirectly) {
  start().catch(error => {
    console.error(`vidu-digital-human: ${error.message}`)
    process.exitCode = 1
  })
}

export { start }
