import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAssistantSoulStore } from '../src/assistant-soul.mjs'

test('desktop edits the active voice persona with a conflict check', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-soul-'))
  try {
    const path = join(directory, 'ASSISTANT.md')
    writeFileSync(path, '# Assistant\n\n* **名字**：SOUL\n', { mode: 0o600 })
    const store = createAssistantSoulStore({ defaultPath: path, env: {}, runtimeRoot: directory })
    const original = '# Assistant\n\n* **名字**：SOUL\n'
    assert.deepEqual(store.load(), { path: realpathSync(path), content: original, name: 'SOUL' })
    assert.equal(store.save({ content: original, name: '星语', expectedContent: original, expectedName: 'SOUL' }).changed, true)
    assert.match(readFileSync(path, 'utf8'), /role-name "星语"/)
    assert.match(readFileSync(path, 'utf8'), /\* \*\*名字\*\*：星语/)
    assert.deepEqual(store.load(), { path: realpathSync(path), content: '# Assistant\n\n* **名字**：星语\n', name: '星语' })
    assert.throws(() => store.save({ content: original, name: 'Other', expectedContent: original, expectedName: 'SOUL' }), /其他程序修改/)
    assert.throws(() => store.save({ content: '   ', name: '星语', expectedContent: original, expectedName: '星语' }), /不能为空/)
    assert.throws(() => store.save({ content: 'x'.repeat(4001), name: '星语', expectedContent: original, expectedName: '星语' }), /4000/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
