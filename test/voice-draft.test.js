import test from 'node:test';
import assert from 'node:assert/strict';
import { insertDictation } from '../src/renderer/voice-draft.js';

test('dictation preserves an existing draft on both sides of the cursor', () => {
  const result = insertDictation('开头结尾', '新的语音内容', { at: 2 });
  assert.equal(result.value, '开头\n新的语音内容\n结尾');
  assert.equal(result.caret, 9);
  assert.equal(result.truncated, false);
});

test('dictation uses current input rather than a stale captured draft', () => {
  const edited = '用户后来又输入了一句。';
  const result = insertDictation(edited, '  转写结果  ');
  assert.equal(result.value, edited + '\n转写结果');
  assert.equal(result.inserted, '转写结果');
});

test('dictation respects maxlength without removing existing text or splitting emoji', () => {
  assert.deepEqual(insertDictation('1234', '更多内容', { maxLength: 4 }), { value: '1234', caret: 4, inserted: '', truncated: true });
  const result = insertDictation('a', 'b😀c', { maxLength: 4 });
  assert.equal(result.value, 'a\nb');
  assert.equal(result.truncated, true);
  assert.equal(insertDictation('😀', '好', { at: 1 }).value, '😀\n好');
});

test('empty transcription leaves the draft unchanged', () => {
  assert.deepEqual(insertDictation('草稿', '  '), { value: '草稿', caret: 2, inserted: '', truncated: false });
});
