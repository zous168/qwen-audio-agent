/**
 * Provider-neutral contracts for server-side digital-human presentation.
 *
 * The module intentionally contains data validation only. It must not import
 * WebRTC, a vendor SDK, a renderer runtime, or a client protocol.
 */

export const DIGITAL_HUMAN_STATES = Object.freeze([
  'disabled',
  'starting',
  'ready',
  'rendering',
  'audio_only',
  'error',
  'closed',
])

export const DIGITAL_HUMAN_CANCEL_REASONS = Object.freeze([
  'user_interruption',
  'content_safety',
  'permission_revoked',
  'owner_replaced',
  'provider_failure',
  'transport_lost',
  'session_closed',
])

export const DIGITAL_HUMAN_ERROR_CODES = Object.freeze([
  'unavailable',
  'capacity_exhausted',
  'invalid_media',
  'first_media_timeout',
  'media_stalled',
  'protocol_error',
])

export function normalizeAudioFormat(format = {}) {
  const encoding = format.encoding || 'pcm_s16le'
  const sampleRate = Number(format.sampleRate || 24_000)
  const channels = Number(format.channels || 1)
  if (encoding !== 'pcm_s16le') throw new TypeError('digital-human audio encoding must be pcm_s16le')
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) {
    throw new TypeError('digital-human audio sampleRate must be an integer between 8000 and 96000')
  }
  if (channels !== 1) throw new TypeError('digital-human audio must be mono')
  return Object.freeze({ encoding, sampleRate, channels })
}

export function normalizeTurnRef(ref) {
  if (!ref || typeof ref !== 'object') throw new TypeError('digital-human TurnRef is required')
  const avatarSessionId = String(ref.avatarSessionId || '')
  const responseId = String(ref.responseId || '')
  const generation = Number(ref.generation)
  if (!avatarSessionId || !responseId || !Number.isInteger(generation) || generation < 0) {
    throw new TypeError('digital-human TurnRef requires avatarSessionId, responseId and generation')
  }
  return Object.freeze({ avatarSessionId, responseId, generation })
}

export function cloneTurnRef(ref) {
  return normalizeTurnRef(ref)
}

export function assertTurnRefMatches(expected, actual) {
  const left = normalizeTurnRef(expected)
  const right = normalizeTurnRef(actual)
  if (
    left.avatarSessionId !== right.avatarSessionId
    || left.responseId !== right.responseId
    || left.generation !== right.generation
  ) throw Object.assign(new Error('digital-human turn reference is stale'), { code: 'stale_turn' })
  return right
}

export function normalizeCancelReason(reason) {
  return DIGITAL_HUMAN_CANCEL_REASONS.includes(reason) ? reason : 'provider_failure'
}

export function normalizeProviderError(error, fallbackCode = 'unavailable') {
  const code = DIGITAL_HUMAN_ERROR_CODES.includes(error?.code)
    ? error.code
    : fallbackCode
  const normalized = new Error(String(error?.message || code))
  normalized.code = code
  normalized.retryable = error?.retryable !== false
  if (error?.cause) normalized.cause = error.cause
  return normalized
}

export function isDigitalHumanState(value) {
  return DIGITAL_HUMAN_STATES.includes(value)
}
