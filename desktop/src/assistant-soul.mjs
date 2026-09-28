import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { replaceFileSync, withFileTransaction } from '../../shared/file-transaction-lock.mjs'
import {
  assistantProfileBody,
  assistantRoleName,
  cleanAssistantRoleName,
  withAssistantRoleName,
} from '../../shared/assistant-role-name.mjs'
import {
  loadFrontendProfile,
  resolveFrontendProfileConfiguration,
} from '../../shared/frontend-profile.mjs'

function createSoulFileStore({ path, maxChars, label }) {
  try { path = realpathSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const load = () => {
    const source = readFileSync(path, 'utf8')
    return { path, content: assistantProfileBody(source), name: assistantRoleName(source) }
  }

  return {
    load,
    save({ content, name, expectedContent, expectedName }) {
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`${label} 不能为空`)
      }
      const nextName = cleanAssistantRoleName(name)
      if ([...content].length > maxChars) {
        throw new Error(`${label} 不能超过 ${maxChars} 字`)
      }
      return withFileTransaction(path, () => {
        const current = load()
        if (current.content !== expectedContent || current.name !== expectedName) {
          throw new Error(`${label} 已被其他程序修改，请重新打开设置后再保存`)
        }
        if (current.content === content && current.name === nextName) {
          return { ...current, changed: false }
        }
        const nextContent = withAssistantRoleName(content, nextName)
        if ([...nextContent].length > maxChars) {
          throw new Error(`${label} 不能超过 ${maxChars} 字`)
        }
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
        try {
          writeFileSync(temporary, nextContent, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
          replaceFileSync(temporary, path)
          chmodSync(path, 0o600)
        } catch (error) {
          try { unlinkSync(temporary) } catch {}
          throw error
        }
        return { ...load(), changed: true }
      })
    },
  }
}

export function createAssistantSoulStore({ defaultPath, env = process.env, runtimeRoot }) {
  const profile = loadFrontendProfile({ filePath: env.QWEN_AUDIO_FRONTEND_PROFILE })
  const configuration = resolveFrontendProfileConfiguration({
    profile, env, defaultAssistantProfilePath: defaultPath,
    baseDirectory: runtimeRoot,
  })
  return createSoulFileStore({
    path: resolve(configuration.assistantProfilePath), maxChars: 4_000,
    label: '语音 SOUL',
  })
}
