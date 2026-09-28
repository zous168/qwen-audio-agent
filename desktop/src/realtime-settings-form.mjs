import { REALTIME_PROVIDERS, REALTIME_SETTING_SLOTS, realtimeSettingsProfileState, realtimeSettingsFromProfileState, realtimeProfileFieldKey } from '../../shared/realtime-provider-definitions.mjs'
import { realtimeModelCatalog, resolveRealtimeModelProfile } from '../../shared/realtime-model-catalog.mjs'
import { isKnownRealtimeSystemVoice, realtimeVoiceLabel, realtimeVoiceOptions } from '../../shared/realtime-voice-catalog.mjs'
import { createSettingsPicker } from './settings-picker.mjs'

const CUSTOM_VOICE_OPTION = '__custom_voice__'

export function realtimeSettingsFields(provider, values) {
  const model = provider.settings.find(field => field.type === 'model')
  const profile = model ? resolveRealtimeModelProfile(values[model.key], provider.key) : null
  return REALTIME_SETTING_SLOTS.map(slot => {
    const field = provider.settings.find(field => field.slot === slot.slot
      && (!field.modelFamily || field.modelFamily === profile?.family))
    if (!field) {
      return {
        ...slot, disabled: true,
        displayValue: slot.slot === 'model' ? provider.modelLabel || '由服务端配置'
          : slot.slot === 'voice' && model ? '当前模型未提供音色配置' : '当前前台不支持配置',
      }
    }
    return {
      ...field, disabled: false,
      placeholder: field.modelFamily ? profile.sessionDefaults.voice || '模型默认音色'
        : field.placeholder || field.activeDefault || field.default,
      voiceOptions: slot.slot === 'voice' ? realtimeVoiceOptions(provider.key, profile?.id) : null,
    }
  })
}

export function createRealtimeSettingsForm({ pickerRoot, panel, onChange, onPreview, openExternal, translate = text => text }) {
  const document = panel.ownerDocument
  const draft = settings => {
    const initial = realtimeSettingsProfileState(settings)
    return { activeProvider: initial.activeProvider, profiles: Object.fromEntries(
      Object.entries(initial.profiles).map(([key, profile]) => [key, { ...profile }]),
    ) }
  }
  let state = draft()
  const values = () => realtimeSettingsFromProfileState(state)
  const currentProvider = () => REALTIME_PROVIDERS.find(provider => provider.key === state.activeProvider) || REALTIME_PROVIDERS[0]
  const picker = createSettingsPicker(pickerRoot, {
    translate,
    onSelect(value) {
      state.activeProvider = value
      for (const field of currentProvider().settings) {
        const profile = state.profiles[value]
        const key = realtimeProfileFieldKey(field)
        if (!profile[key] && field.activeDefault) profile[key] = field.activeDefault
      }
      render()
      onChange()
    },
  })
  const make = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text) node.textContent = translate(text)
    return node
  }

  function renderPicker() {
    picker.render({
      title: translate('选择实时语音引擎'), value: state.activeProvider,
      options: REALTIME_PROVIDERS.map(provider => ({
        value: provider.key, label: translate(provider.displayLabel || provider.label),
        keywords: `${provider.label} ${translate(provider.description)} ${provider.aliases.join(' ')}`,
        status: translate(values()[provider.requiredConfiguration.field]?.trim() ? '已配置' : '待配置'),
      })),
    })
  }

  function renderField(field, provider) {
    const row = make('div', 'setting-row')
    const label = make('label', '', field.label)
    label.htmlFor = `realtime-${field.key || `${provider.key}-${field.slot}`}`
    const voiceOptions = field.voiceOptions
    const input = make((field.type === 'model' || voiceOptions) && !field.disabled ? 'select' : 'input')
    input.id = label.htmlFor
    input.dataset.realtimeSlot = field.slot
    if (field.disabled) {
      input.type = 'text'
      input.disabled = true
      input.dataset.settingUnavailable = ''
      input.value = translate(field.displayValue)
      input.title = translate('当前前台不支持配置')
      row.append(label, input)
      return row
    }
    input.dataset.setting = field.key
    if (voiceOptions) {
      const fallback = make('option')
      fallback.value = ''
      const voiceLanguage = translate('音色') === '音色' ? 'zh' : 'en'
      fallback.textContent = `${translate('使用默认音色')}（${realtimeVoiceLabel(field.placeholder, voiceLanguage)}）`
      input.append(fallback)
      for (const voice of voiceOptions) {
        const option = make('option', '', realtimeVoiceLabel(voice, voiceLanguage))
        option.value = voice
        input.append(option)
      }
      const custom = make('option', '', '自定义音色 ID…')
      custom.value = CUSTOM_VOICE_OPTION
      input.append(custom)
      const savedVoice = values()[field.key]
      const isCustom = Boolean(savedVoice && !voiceOptions.includes(savedVoice))
      input.value = isCustom ? CUSTOM_VOICE_OPTION : savedVoice
      const customInput = make('input', 'voice-custom-input')
      customInput.type = 'text'
      customInput.autocomplete = 'off'
      customInput.spellcheck = false
      customInput.placeholder = translate('输入自定义音色 ID')
      customInput.setAttribute('aria-label', translate('自定义音色 ID'))
      customInput.value = isCustom ? savedVoice : ''
      customInput.hidden = !isCustom
      customInput.required = isCustom
      customInput.addEventListener('input', () => {
        state.profiles[provider.key][realtimeProfileFieldKey(field)] = customInput.value.trim()
        onChange()
      })
      input.addEventListener('change', () => {
        const customSelected = input.value === CUSTOM_VOICE_OPTION
        customInput.hidden = !customSelected
        customInput.required = customSelected
        state.profiles[provider.key][realtimeProfileFieldKey(field)] = customSelected
          ? customInput.value.trim() : input.value
        if (customSelected) customInput.focus()
        onChange()
      })
      const controls = make('div', 'voice-select-controls')
      const line = make('div', 'voice-preview-line')
      line.append(input)
      if (onPreview) {
        const preview = make('button', 'voice-preview-button', '试听')
        preview.type = 'button'
        input.addEventListener('change', () => { preview.textContent = translate('试听') })
        customInput.addEventListener('input', () => { preview.textContent = translate('试听') })
        preview.addEventListener('click', async () => {
          const voice = input.value === CUSTOM_VOICE_OPTION ? customInput.value.trim()
            : input.value || field.placeholder
          const isCurrent = () => panel.contains(input)
            && (input.value === CUSTOM_VOICE_OPTION ? customInput.value.trim()
              : input.value || field.placeholder) === voice
          if (!voice) {
            feedback.textContent = translate('输入自定义音色 ID')
            feedback.hidden = false
            return
          }
          feedback.hidden = true
          preview.disabled = true
          preview.textContent = translate('试听中…')
          try {
            const played = await onPreview({ model: values().realtimeModel, voice, isCurrent })
            preview.textContent = played === false || !isCurrent()
              ? translate('试听') : translate('试听完成')
          } catch (error) {
            preview.textContent = translate('重试试听')
            feedback.textContent = error.message || translate('试听失败')
            feedback.hidden = false
          } finally {
            preview.disabled = false
          }
        })
        line.append(preview)
      }
      const feedback = make('p', 'voice-preview-feedback')
      feedback.setAttribute('role', 'status')
      feedback.hidden = true
      input.addEventListener('change', () => { feedback.hidden = true })
      customInput.addEventListener('input', () => { feedback.hidden = true })
      controls.append(line, customInput, feedback)
      row.append(label, controls)
      return row
    }
    if (field.type === 'model') {
      const catalog = realtimeModelCatalog(provider.key)
      for (const profile of catalog?.profiles || []) {
        const option = make('option', '', profile.label)
        option.value = profile.id
        input.append(option)
      }
      if (values()[field.key] && ![...input.options].some(option => option.value === values()[field.key])) {
        const option = make('option', '', values()[field.key])
        option.value = values()[field.key]
        input.append(option)
      }
    } else {
      input.type = field.type
      input.autocomplete = 'off'
      input.spellcheck = false
      input.placeholder = translate(field.placeholder || '')
    }
    input.value = values()[field.key]
    input.addEventListener('input', () => {
      state.profiles[provider.key][realtimeProfileFieldKey(field)] = input.value
      renderPicker()
      onChange()
    })
    input.addEventListener('change', () => {
      state.profiles[provider.key][realtimeProfileFieldKey(field)] = input.value
      if (field.type === 'model') {
        const nextProfile = resolveRealtimeModelProfile(input.value, provider.key)
        const voiceField = provider.settings.find(candidate => candidate.slot === 'voice'
          && (!candidate.modelFamily || candidate.modelFamily === nextProfile.family))
        const voiceKey = voiceField && realtimeProfileFieldKey(voiceField)
        const voice = voiceKey && state.profiles[provider.key][voiceKey]
        const options = realtimeVoiceOptions(provider.key, input.value)
        if (voice && options && !options.includes(voice)
          && isKnownRealtimeSystemVoice(provider.key, voice)) {
          state.profiles[provider.key][voiceKey] = ''
        }
        render()
        panel.querySelector(`[data-setting="${field.key}"]`)?.focus()
      }
      onChange()
    })
    row.append(label)
    if (field.helpUrl) {
      const wrapper = make('div', 'field-with-action')
      const action = make('button', 'link-button', '获取 API Key')
      action.type = 'button'
      action.addEventListener('click', () => openExternal(field.helpUrl))
      wrapper.append(input, action)
      row.append(wrapper)
    } else row.append(input)
    return row
  }

  function render() {
    const provider = currentProvider()
    state.activeProvider = provider.key
    renderPicker()
    const fields = realtimeSettingsFields(provider, values())
    const children = fields.map(field => renderField(field, provider))
    children.push(make('p', 'provider-attribution', provider.description))
    panel.replaceChildren(...children)
  }

  return {
    load(settings) { state = draft(settings); render() },
    values,
    render,
  }
}
