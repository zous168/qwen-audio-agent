import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assistantProfileBody,
  assistantRoleName,
  withAssistantRoleName,
} from './assistant-role-name.mjs'

test('uses a role name already written in the SOUL persona', () => {
  const source = '# 角色設定：SOUL\n\n* **名字**：SOUL\n'
  assert.equal(assistantRoleName(source), 'SOUL')
  const saved = withAssistantRoleName(source, '星语')
  assert.equal(assistantRoleName(saved), '星语')
  assert.equal(assistantProfileBody(saved), '# 角色設定：星语\n\n* **名字**：星语\n')
  assert.equal(withAssistantRoleName(saved, '新名字').match(/role-name/g)?.length, 1)
})

test('updates the packaged assistant name when an explicit role name is saved', () => {
  const source = '没有当前用户的个性化覆盖时，你叫千问Audio。\n'
  assert.equal(assistantRoleName(source), '千问Audio')
  assert.match(assistantProfileBody(withAssistantRoleName(source, 'SOUL')), /你叫SOUL。/)
})
