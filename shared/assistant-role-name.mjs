const NAME_MARKER = /^<!-- qwen-audio-agent:role-name ("(?:[^"\\]|\\.)*") -->\r?\n?/u
const LEGACY_NAME_LINE = /^(\s*(?:[-*]\s*)?(?:\*\*)?(?:角色名称|角色名稱|名字|名称|名稱)(?:\*\*)?\s*[：:]\s*)([^\r\n]+)$/imu

export function cleanAssistantRoleName(value) {
  const name = String(value || '').trim()
  if (!name || [...name].length > 40 || /[\r\n<>\p{Cc}]/u.test(name)) {
    throw new Error('角色名称须为 1–40 个字符，且不能包含换行或尖括号')
  }
  return name
}

export function assistantProfileBody(content) {
  return String(content || '').replace(NAME_MARKER, '')
}

export function assistantRoleName(content) {
  const source = String(content || '')
  const marker = NAME_MARKER.exec(source)
  if (marker) {
    try { return cleanAssistantRoleName(JSON.parse(marker[1])) } catch {}
  }
  const legacy = LEGACY_NAME_LINE.exec(source)
  if (legacy) {
    try { return cleanAssistantRoleName(legacy[2].replace(/^\*\*|\*\*$/gu, '').trim()) } catch {}
  }
  const called = /你叫[「“]?([^「」“”。，\n]{1,40})[」”]?/u.exec(source)
  if (called) {
    try { return cleanAssistantRoleName(called[1]) } catch {}
  }
  return '语音助手'
}

export function withAssistantRoleName(content, name) {
  const nextName = cleanAssistantRoleName(name)
  const body = assistantProfileBody(content)
  const oldName = assistantRoleName(content)
  const legacy = LEGACY_NAME_LINE.exec(body)
  let updatedBody = legacy && legacy[2].trim() === oldName
    ? body.replace(LEGACY_NAME_LINE, (_, prefix) => `${prefix}${nextName}`)
    : body
  updatedBody = updatedBody
    .replace(`角色設定：${oldName}`, `角色設定：${nextName}`)
    .replace(`角色设置：${oldName}`, `角色设置：${nextName}`)
  updatedBody = updatedBody.replace(`你叫${oldName}`, `你叫${nextName}`)
  return `<!-- qwen-audio-agent:role-name ${JSON.stringify(nextName)} -->\n${updatedBody}`
}
