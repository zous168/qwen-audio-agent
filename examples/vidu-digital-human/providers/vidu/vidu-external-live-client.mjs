/**
 * Vidu S Avatar Component (外接直播) client.
 * Docs: https://platform.vidu.com/vidu-stream/doc/s2-avatar/component/parameters
 */

function authHeader(apiKey, { websocket = false } = {}) {
  const token = apiKey.startsWith('Token ') ? apiKey : `Token ${apiKey}`
  return { Authorization: websocket ? token.replace(/^Token\s+/i, '') : token }
}

export async function createExternalLive(config, { fetchImpl = fetch, signal } = {}) {
  const body = {
    model: config.model,
    ...config.avatar,
    rtc_info: config.rtcInfo,
    ...(config.moderation ? { moderation: config.moderation } : {}),
    ...(config.extraMotion ? { extra_motion: true } : {}),
  }

  const response = await fetchImpl(`${config.httpBase}${config.createPath}`, {
    method: 'POST',
    headers: {
      ...authHeader(config.apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = payload?.message || payload?.error || response.statusText
    throw new Error(`Vidu create avatar component session failed (${response.status}): ${detail}`)
  }

  const liveId = String(payload?.live?.id ?? '')
  const clientSecret = payload?.client_secret
  if (!liveId || !clientSecret) {
    throw new Error('Vidu create external live returned incomplete live.id or client_secret.')
  }

  return {
    liveId,
    clientSecret,
    live: payload.live,
    traceId: payload.live?.trace_id,
  }
}

export async function getLive(config, liveId, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${config.httpBase}/live/v1/lives/${encodeURIComponent(liveId)}`, {
    headers: authHeader(config.apiKey),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`Vidu get live failed (${response.status})`)
  }
  return payload.live
}

function nextSeq(state) {
  state.seqId += 1
  return state.seqId
}

function buildSignal(state, type, payload) {
  return JSON.stringify({
    type,
    live_id: state.liveId,
    conn_id: state.connId,
    seq_id: nextSeq(state),
    payload,
  })
}

/**
 * Opens the component WebSocket and waits for conn_init_ack.success === true.
 * Uses dynamic import so unit tests can run without installing ws in the example folder.
 */
export async function openExternalLiveStream(config, session, handlers = {}) {
  const WebSocket = handlers.WebSocket || (await import('ws')).WebSocket
  const connId = session.connId || `qwa-${Date.now()}`
  const streamPathTemplate = String(config.streamPath || '/live/v1/external-lives/{liveId}/stream')
  const streamPath = streamPathTemplate.replace('{liveId}', encodeURIComponent(session.liveId))
  const url = new URL(`${config.wsBase}${streamPath}`)
  if (!streamPathTemplate.includes('{liveId}')) url.searchParams.set('live_id', session.liveId)
  url.searchParams.set('conn_id', connId)
  // Keep the short-lived client secret out of URLs and proxy/access logs by
  // default. Set VIDU_WS_CLIENT_SECRET=1 only for legacy Vidu deployments that
  // do not accept the server-side Authorization header.
  if (config.useClientSecretInWs && session.clientSecret) url.searchParams.set('client_secret', session.clientSecret)

  const state = {
    liveId: session.liveId,
    connId,
    seqId: 0,
    ready: false,
    notReadyRetries: 0,
    retryTimer: null,
  }

  const socket = new WebSocket(url.toString(), { headers: authHeader(config.apiKey, { websocket: true }) })
  const aborted = () => { try { socket.close() } catch {} }
  handlers.signal?.addEventListener('abort', aborted, { once: true })

  const waitReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearTimeout(state.retryTimer)
      try { socket.close() } catch {}
      reject(new Error('Vidu conn_init_ack timed out'))
    }, 30_000)

    socket.on('message', raw => {
      if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return
      }

      handlers.onSignal?.(message)

      if (message.type === 2) {
        const ack = message.payload?.conn_init_ack
        if (ack?.success) {
          state.ready = true
          clearTimeout(timeout)
          clearTimeout(state.retryTimer)
          resolve()
        } else if (ack?.error_code === 'NOT_READY') {
          if (++state.notReadyRetries > 100) {
            clearTimeout(timeout)
            clearTimeout(state.retryTimer)
            try { socket.close() } catch {}
            reject(new Error('Vidu conn_init remained NOT_READY'))
          } else {
            clearTimeout(state.retryTimer)
            state.retryTimer = setTimeout(() => {
              if (!state.ready) socket.send(buildSignal(state, 1, { conn_init: { version: 1 } }))
            }, 250)
          }
        } else {
          clearTimeout(timeout)
          reject(new Error(ack?.error_msg || ack?.error_code || 'conn_init failed'))
        }
      }

      if (message.type === 6) {
        handlers.onForceHangup?.(message.payload?.hangup)
      }
    })

    socket.on('error', error => {
      clearTimeout(timeout)
      clearTimeout(state.retryTimer)
      reject(error)
      if (state.ready) handlers.onError?.(error)
    })

    socket.on('close', () => {
      clearTimeout(timeout)
      clearTimeout(state.retryTimer)
      handlers.signal?.removeEventListener('abort', aborted)
      if (!state.ready) reject(new Error('Vidu WebSocket closed before ready'))
      state.ready = false
      handlers.onClose?.()
    })
  })

  socket.on('open', () => {
    if (handlers.signal?.aborted) { socket.close(); return }
    socket.send(buildSignal(state, 1, { conn_init: { version: 1 } }))
  })

  try { await waitReady } catch (error) {
    handlers.signal?.removeEventListener('abort', aborted)
    try { socket.close() } catch {}
    throw error
  }
  if (handlers.signal?.aborted) { socket.close(); throw new Error('Vidu session aborted') }

  return {
    liveId: session.liveId,
    connId,
    isReady: () => state.ready,
    sendPcm(buffer) {
      if (!state.ready) throw new Error('Vidu stream not ready')
      if (socket.bufferedAmount > 1024 * 1024) throw new Error('Vidu stream is not consuming audio')
      socket.send(buffer)
    },
    sendInputTranscription(content, msgId = `in-${Date.now()}`) {
      if (!content?.trim()) return
      socket.send(buildSignal(state, 9, {
        text_msg: {
          msg_id: msgId,
          content,
          timestamp: Date.now(),
        },
      }))
    },
    sendOutputTranscription(content, msgId = `out-${Date.now()}`) {
      if (!content?.trim()) return
      socket.send(buildSignal(state, 10, {
        text_msg: {
          msg_id: msgId,
          content,
          timestamp: Date.now(),
        },
      }))
    },
    interrupt() {
      socket.send(buildSignal(state, 7, {}))
    },
    hangup(reason = 'client_hangup') {
      socket.send(buildSignal(state, 5, { hangup: { hangup_reason: reason } }))
      socket.close()
    },
    close() {
      socket.close()
    },
  }
}

/** PCM16 LE mono @ 24kHz — matches qwen web OUTPUT_RATE and Vidu component spec. */
export function decodeAssistantAudioBase64(base64) {
  const binary = Buffer.from(base64, 'base64')
  if (binary.byteLength % 2 !== 0) {
    throw new RangeError('PCM16 payload must have an even byte length')
  }
  return binary
}
