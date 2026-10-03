import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadViduConfig } from '../providers/vidu/vidu-config.mjs'

const invokedDirectly = process.argv[1]
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])

if (invokedDirectly) {
  try {
    try {
      process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const config = loadViduConfig(process.env)
    console.log('Vidu config OK')
    console.log(`  host: ${config.host}`)
    console.log(`  avatar: ${config.avatar.image_uri ? 'image_uri' : 'avatar_id'}`)
    console.log(`  rtc provider: ${config.rtcInfo.provider}`)
  } catch (error) {
    console.error(`preflight: ${error.message}`)
    process.exitCode = 1
  }
}
