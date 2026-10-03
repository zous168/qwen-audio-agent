const DEFAULT_HOST = 'api.vidu.cn'
export const SUPPORTED_RTC_PROVIDERS = Object.freeze(['artc', 'trtc', 'agora', 'volcengine'])

export function loadViduConfig(environment = process.env) {
  const apiKey = environment.VIDU_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('VIDU_API_KEY is required for Vidu S component integration.')
  }

  const host = (environment.VIDU_API_HOST || DEFAULT_HOST).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const imageUri = environment.VIDU_AVATAR_IMAGE_URI?.trim() || ''
  const avatarId = environment.VIDU_AVATAR_ID?.trim() || ''

  if (!imageUri && !avatarId) {
    throw new Error('Set VIDU_AVATAR_IMAGE_URI or VIDU_AVATAR_ID.')
  }

  const provider = environment.VIDU_RTC_PROVIDER?.trim() || 'artc'
  if (!SUPPORTED_RTC_PROVIDERS.includes(provider)) {
    throw new Error(`VIDU_RTC_PROVIDER must be one of: ${SUPPORTED_RTC_PROVIDERS.join(', ')}`)
  }
  const rtcInfo = {
    provider,
    channel_id: environment.VIDU_RTC_CHANNEL_ID?.trim() || '',
    user_id: environment.VIDU_RTC_USER_ID?.trim() || '',
    token: environment.VIDU_RTC_TOKEN?.trim() || '',
  }
  const appId = environment.VIDU_RTC_APP_ID?.trim()
  if (appId) rtcInfo.app_id = appId

  for (const [key, value] of Object.entries(rtcInfo)) {
    if (key === 'app_id') continue
    if (!value) {
      throw new Error(`VIDU_RTC_* is incomplete (missing ${key} on rtc_info).`)
    }
  }

  return {
    apiKey,
    model: environment.VIDU_MODEL?.trim() || 'vidu-s2',
    personaId: environment.VIDU_PERSONA_ID?.trim() || 'default',
    personaLabel: environment.VIDU_PERSONA_LABEL?.trim() || 'Vidu Avatar',
    host,
    httpBase: `https://${host}`,
    wsBase: `wss://${host}`,
    avatar: imageUri ? { image_uri: imageUri } : { avatar_id: avatarId },
    rtcInfo,
    createPath: environment.VIDU_CREATE_PATH?.trim() || '/live/s_avatar/component',
    streamPath: environment.VIDU_STREAM_PATH?.trim() || '/live/v1/external-lives/{liveId}/stream',
    useClientSecretInWs: environment.VIDU_WS_CLIENT_SECRET === '1',
    moderation: environment.VIDU_MODERATION?.trim() || '',
    extraMotion: environment.VIDU_EXTRA_MOTION === '1',
  }
}
