// System voices documented by Model Studio. Custom/cloned voice IDs remain
// accepted by the settings form and are intentionally absent from these lists.
// https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides
// https://help.aliyun.com/zh/model-studio/omni-voice-list
const AUDIO_30_VOICES = Object.freeze([
  'longanqian', 'longanlingxin', 'longanlingxi', 'longanxiaoxin', 'longanlufeng',
])

const OMNI_38_VOICES = Object.freeze([
  'Tina', 'Cindy', 'Liora Mira', 'Raymond', 'Zane', 'Katerina', 'Ryan', 'Mia',
  'Cici', 'Theo Calm', 'Serena', 'Maia', 'Evan', 'Qiao', 'Momo', 'Wil', 'Angel',
  'Li Cassian', 'Joyner', 'Gold', 'Jennifer', 'Aiden', 'Mione', 'Sunny', 'Dylan',
  'Eric', 'Peter', 'Joseph Chen', 'Marcus', 'Li', 'Rocky', 'Kiki', 'Sohee',
  'Eliška', 'Alek', 'Arda', 'Dolce', 'Lenn', 'Ono Anna', 'Sonrisa', 'Bodega',
  'Andre', 'Radio Gol', 'Rizky', 'Roya', 'Hana', 'Jakub', 'Griet', 'Marina',
  'Siiri', 'Ingrid', 'Sigga', 'Bea', 'Chloe', 'Emilien', 'longanlingxin',
])

const OMNI_35_VOICES = Object.freeze([
  'Tina', 'Cindy', 'Liora Mira', 'Sunnybobi', 'Raymond', 'Ethan', 'Theo Calm',
  'Serena', 'Harvey', 'Maia', 'Evan', 'Qiao', 'Momo', 'Wil', 'Angel', 'Li Cassian',
  'Mia', 'Joyner', 'Gold', 'Katerina', 'Ryan', 'Jennifer', 'Aiden', 'Mione',
  'Sunny', 'Dylan', 'Eric', 'Peter', 'Joseph Chen', 'Marcus', 'Li', 'Kiki',
  'Rocky', 'Sohee', 'Lenn', 'Ono Anna', 'Sonrisa', 'Bodega', 'Emilien', 'Andre',
  'Radio Gol', 'Alek', 'Rizky', 'Roya', 'Arda', 'Hana', 'Dolce', 'Jakub', 'Griet',
  'Eliška', 'Marina', 'Siiri', 'Ingrid', 'Sigga', 'Bea', 'Chloe',
])

const DASHSCOPE_VOICE_CATALOG = Object.freeze({
  'qwen-audio-3.0-realtime-plus': AUDIO_30_VOICES,
  'qwen-audio-3.0-realtime-flash': AUDIO_30_VOICES,
  'qwen3.8-omni-flash-realtime': OMNI_38_VOICES,
  'qwen3.5-omni-flash-realtime': OMNI_35_VOICES,
  'qwen3.5-omni-plus-realtime': OMNI_35_VOICES,
})
const KNOWN_DASHSCOPE_VOICES = new Set(
  Object.values(DASHSCOPE_VOICE_CATALOG).flat(),
)

// Display names follow the Model Studio voice lists. Keep the API ID visible so
// users can still identify the exact voice being sent to DashScope.
const VOICE_NAMES_ZH = Object.freeze({
  longanqian: '默认音色', longanlingxin: '龙安灵心', longanlingxi: '龙安灵希',
  longanxiaoxin: '龙安小昕', longanlufeng: '龙安鲁风',
  Tina: '甜甜', Cindy: '林欣宜', 'Liora Mira': '清欢', Raymond: '林川野',
  Zane: '泽恩', Katerina: '卡捷琳娜', Ryan: '甜茶', Mia: '舒然', Cici: '绵绵',
  'Theo Calm': '予安', Serena: '苏瑶', Maia: '四月', Evan: '江晨', Qiao: '小乔妹',
  Momo: '茉兔', Wil: '伟伦', Angel: '台普·安琪', 'Li Cassian': '东厂·李公公',
  Joyner: '喜剧担当·阿逗', Gold: '金爷', Jennifer: '詹妮弗', Aiden: '艾登',
  Mione: '敏儿', Sunny: '四川·晴儿', Dylan: '北京·晓东', Eric: '四川·程川',
  Peter: '天津·李彼得', 'Joseph Chen': '阿樸伯', Marcus: '陕西·秦川',
  Li: '南京·老李', Rocky: '粤语·阿强', Kiki: '粤语·阿清', Sohee: '素熙',
  Eliška: '艾莉卡', Alek: '阿列克', Arda: '阿尔达', Dolce: '多尔切',
  Lenn: '莱恩', 'Ono Anna': '小野杏', Sonrisa: '索尼莎', Bodega: '博德加',
  Andre: '安德雷', 'Radio Gol': '拉迪奥·戈尔', Rizky: '阿力', Roya: '萝雅',
  Hana: '阿幸', Jakub: '雅克', Griet: '海娜', Marina: '玛丽娜',
  Siiri: '西芮', Ingrid: '林恩', Sigga: '海娜', Bea: '雅娜', Chloe: '思怡',
  Emilien: '埃米尔安', Sunnybobi: '知芝', Ethan: '晨煦', Harvey: '厚',
})

export function realtimeVoiceOptions(provider, model) {
  if (provider !== 'dashscope') return null
  return DASHSCOPE_VOICE_CATALOG[String(model || '').trim()] || null
}

export function isKnownRealtimeSystemVoice(provider, voice) {
  return provider === 'dashscope' && KNOWN_DASHSCOPE_VOICES.has(String(voice || '').trim())
}

export function realtimeVoiceLabel(voice, language = 'zh') {
  const id = String(voice || '').trim()
  const name = language === 'zh' ? VOICE_NAMES_ZH[id] : null
  return name ? `${name} · ${id}` : id
}
