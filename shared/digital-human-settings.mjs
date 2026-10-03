export const VIDU_RTC_PROVIDERS = Object.freeze(['artc', 'trtc', 'agora', 'volcengine'])

export const VIDU_SETTING_FIELDS = Object.freeze([
  ['viduApiKey', 'VIDU_API_KEY'],
  ['viduApiHost', 'VIDU_API_HOST'],
  ['viduAvatarImageUri', 'VIDU_AVATAR_IMAGE_URI'],
  ['viduAvatarId', 'VIDU_AVATAR_ID'],
  ['viduPersonaId', 'VIDU_PERSONA_ID'],
  ['viduPersonaLabel', 'VIDU_PERSONA_LABEL'],
  ['viduRtcProvider', 'VIDU_RTC_PROVIDER'],
  ['viduRtcChannelId', 'VIDU_RTC_CHANNEL_ID'],
  ['viduRtcUserId', 'VIDU_RTC_USER_ID'],
  ['viduRtcToken', 'VIDU_RTC_TOKEN'],
  ['viduRtcAppId', 'VIDU_RTC_APP_ID'],
  ['viduRtcBridgeModule', 'VIDU_RTC_BRIDGE_MODULE'],
])

const DEFAULTS = Object.freeze({
  viduApiKey: '', viduApiHost: 'api.vidu.cn',
  viduAvatarImageUri: '', viduAvatarId: '',
  viduPersonaId: 'default', viduPersonaLabel: 'Vidu Avatar',
  viduRtcProvider: 'artc', viduRtcChannelId: '', viduRtcUserId: '',
  viduRtcToken: '', viduRtcAppId: '', viduRtcBridgeModule: '',
})

export function viduSettingsFromEnvironment(environment = {}, fallback = {}) {
  return Object.fromEntries(VIDU_SETTING_FIELDS.map(([field, key]) => [
    field,
    String(environment[key] ?? environment[field] ?? fallback[key] ?? fallback[field] ?? DEFAULTS[field]).trim(),
  ]))
}

export function normalizeViduSettings(settings = {}) {
  const values = viduSettingsFromEnvironment(settings)
  values.viduApiHost = values.viduApiHost
    .replace(/^https?:\/\//, '').replace(/\/+$/, '') || DEFAULTS.viduApiHost
  if (!VIDU_RTC_PROVIDERS.includes(values.viduRtcProvider)) {
    values.viduRtcProvider = DEFAULTS.viduRtcProvider
  }
  return values
}

export function viduSettingsValues(settings = {}) {
  return normalizeViduSettings(settings)
}
