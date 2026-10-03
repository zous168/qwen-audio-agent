import { useEffect, useRef } from 'react'
import { t } from '../i18n.js'
import './digital-human.css'

const labels = {
  off: '语音模式', starting: '数字人连接中', ready: '数字人已就绪',
  rendering: '数字人正在回复', audio_only: '已降级为语音', closed: '数字人已断开',
}

export function DigitalHumanVideo({ stream, compact = false }) {
  const ref = useRef(null)
  useEffect(() => {
    const video = ref.current
    video.srcObject = stream
    if (stream) video.play().catch(() => {})
    return () => { video.srcObject = null }
  }, [stream])
  return <video ref={ref} className={compact ? 'digital-human-orb-video' : 'digital-human-video'}
    autoPlay playsInline muted aria-label={t('数字人画面')} />
}

export function DigitalHumanControls({ capability, voice, desktop = false }) {
  const reason = {
    loading: '正在读取数字人配置', not_configured: '请先在服务端配置 Vidu 和 RTC 桥',
    model_unsupported: '当前模型不支持数字人', transport_disabled: '服务端未启用数字人传输',
    unreachable: '无法读取数字人配置',
    invalid_configuration: '服务端数字人配置无效，请检查密钥和 RTC 桥',
  }[capability.reason]
  return <section className="digital-human-controls" aria-label={t('数字人设置')}>
    <label>{t('对话形象')}
      <select aria-label={t('对话形象')} value={capability.personaId}
        disabled={!capability.available} onChange={event => {
          voice.interrupt()
          voice.activateAudio()
          capability.select(event.target.value)
        }}>
        <option value="">{t('语音模式')}</option>
        {capability.personas.map(persona => <option key={persona.id} value={persona.id}>{persona.label}</option>)}
      </select>
    </label>
    <span role="status">{reason ? t(reason) : t(labels[voice.avatarState] || '数字人连接中')}</span>
    {capability.personaId && ['audio_only', 'closed'].includes(voice.avatarState)
      && <button className="ghost" onClick={voice.retryAvatar}>{t('重连数字人')}</button>}
    {!capability.available && <button className="ghost" onClick={capability.refresh}>{t('刷新')}</button>}
    {desktop && <button className="ghost" onClick={() => window.qwenAudioAgentDesktop?.openSettings()}>{t('服务端设置')}</button>}
  </section>
}

export default function DigitalHumanPanel({ stream, state, onInterrupt }) {
  return <section className="digital-human-panel" aria-label={t('数字人对话')}>
    {stream && state !== 'audio_only' ? <DigitalHumanVideo stream={stream} />
      : <div className="digital-human-placeholder">{t(labels[state] || '数字人连接中')}</div>}
    <button className="ghost" onClick={onInterrupt}>{t('打断回复')}</button>
  </section>
}
