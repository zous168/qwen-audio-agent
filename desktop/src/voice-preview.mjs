import WebSocket from 'ws'
import { realtimeVoiceOptions } from '../../shared/realtime-voice-catalog.mjs'
import { resolveRealtimeModelProfile } from '../../shared/realtime-model-catalog.mjs'

const SAMPLE_RATE = 24_000
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 12
const PREVIEW_TEXT = '你好，这是音色试听。'

export function previewRealtimeVoice({ model, voice, endpoint, credential }, {
  WebSocketClass = WebSocket, timeoutMs = 45_000,
} = {}) {
  const profile = resolveRealtimeModelProfile(model, 'dashscope')
  if (!realtimeVoiceOptions('dashscope', profile?.id)) {
    return Promise.reject(new Error('当前模型不支持音色试听'))
  }
  const selectedVoice = String(voice || '').trim() || profile.sessionDefaults.voice
  if (!selectedVoice || selectedVoice.length > 128) {
    return Promise.reject(new Error('请选择有效的音色'))
  }
  const apiKey = String(credential || '').trim()
  if (!apiKey) return Promise.reject(new Error('请先填写 API Key'))
  let url
  try {
    url = new URL(String(endpoint || ''))
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:'
      && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) {
      throw new Error('Invalid protocol')
    }
    url.searchParams.set('model', profile.id)
  } catch {
    return Promise.reject(new Error('请填写有效的 WebSocket 服务地址'))
  }
  if (profile.id === 'qwen3.8-omni-flash-realtime'
    && ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(url.hostname)) {
    return Promise.reject(new Error('Qwen3.8 Omni 试听需要先配置百炼业务空间专属 WebSocket 服务地址'))
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocketClass(url.href, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    let finished = false
    let itemCreated = false
    let responseRequested = false
    let bytes = 0
    const chunks = []
    const timer = setTimeout(() => finish(new Error('音色试听超时，请检查网络或模型配置')), timeoutMs)
    function finish(error) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      ws.close()
      if (error) reject(error)
      else resolve({ audio: Buffer.concat(chunks, bytes).toString('base64'), sampleRate: SAMPLE_RATE })
    }
    ws.on('message', raw => {
      let event
      try { event = JSON.parse(String(raw)) } catch { return }
      if (event.type === 'session.created') {
        const session = {
          modalities: ['text', 'audio'], turn_detection: null,
          instructions: `你正在试听音色。只说这句话，不要解释：${PREVIEW_TEXT}`,
        }
        if (profile.id === 'qwen3.8-omni-flash-realtime') {
          session.audio = {
            input: { format: { type: 'pcm', sample_rate: 16_000 } },
            output: { format: { type: 'pcm', sample_rate: SAMPLE_RATE }, voice: selectedVoice },
          }
        } else {
          session.voice = selectedVoice
          session.output_audio_format = 'pcm'
          session.input_audio_format = 'pcm'
        }
        ws.send(JSON.stringify({ type: 'session.update', session }))
      }
      if (event.type === 'error') {
        const detail = event.error?.message || event.message || '模型拒绝生成试听音频'
        finish(new Error(String(detail).slice(0, 300)))
        return
      }
      if (event.type === 'session.updated' && !itemCreated) {
        itemCreated = true
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message', role: 'user',
            content: [{ type: 'input_text', text: `请说：${PREVIEW_TEXT}` }],
          },
        }))
      }
      if (event.type === 'conversation.item.created' && !responseRequested) {
        responseRequested = true
        ws.send(JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['text', 'audio'],
            instructions: `请只用中文自然地说出这句话，不要解释：${PREVIEW_TEXT}`,
          },
        }))
      }
      if (event.type === 'response.audio.delta' || event.type === 'response.output_audio.delta') {
        const chunk = Buffer.from(String(event.delta || ''), 'base64')
        bytes += chunk.length
        if (bytes > MAX_AUDIO_BYTES) {
          finish(new Error('音色试听音频过长'))
          return
        }
        chunks.push(chunk)
      }
      if (event.type === 'response.done') {
        if (event.response?.status === 'failed') {
          finish(new Error(event.response.status_details?.error?.message || '音色试听生成失败'))
        } else if (!bytes) {
          finish(new Error('模型没有返回试听音频'))
        } else finish()
      }
    })
    ws.on('error', error => finish(new Error(`音色试听连接失败：${error.message}`)))
    ws.on('close', () => { if (!finished) finish(new Error('音色试听连接已断开')) })
  })
}
