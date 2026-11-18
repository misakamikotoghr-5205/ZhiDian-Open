import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_DEFAULTS, VOICE_PRESETS, validateVoiceConfig } from '../src/main/voice/config.js';
import { MAX_AUDIO_BYTES, MAX_DURATION_SECONDS, validateWav } from '../src/main/voice/wav.js';

function chunk(id, payload, pad = true) {
  const out = Buffer.alloc(8 + payload.length + (pad ? payload.length % 2 : 0));
  out.write(id, 0, 4, 'ascii');
  out.writeUInt32LE(payload.length, 4);
  payload.copy(out, 8);
  return out;
}
function wav({ sampleRate = 16000, channels = 1, seconds = 1, samples, format = 1, bits = 16, extra = [], data, formatSize = 16 } = {}) {
  const fmt = Buffer.alloc(formatSize);
  fmt.writeUInt16LE(format, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * 2, 8);
  fmt.writeUInt16LE(channels * 2, 12);
  fmt.writeUInt16LE(bits, 14);
  const chunks = [chunk('fmt ', fmt), ...extra, chunk('data', data ?? Buffer.alloc((samples ?? Math.round(sampleRate * seconds)) * channels * 2))];
  const out = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'ascii'), ...chunks]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

test('voice presets and defaults are independent from chat and remain opt-in', () => {
  assert.deepEqual(VOICE_DEFAULTS, { enabled: false, preset: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1', language: 'zh', key: '', keyHost: '', keyHint: '' });
  assert.deepEqual(VOICE_PRESETS.map((p) => p.id), ['openai', 'groq', 'local-openai', 'custom']);
  for (const p of VOICE_PRESETS.filter((p) => p.id !== 'custom')) {
    assert.equal(validateVoiceConfig(p).ok, true, p.id);
  }
  const groq = validateVoiceConfig(VOICE_PRESETS.find((p) => p.id === 'groq'));
  assert.equal(groq.endpoint, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(groq.model, 'whisper-large-v3-turbo');
  assert.equal(validateVoiceConfig(VOICE_PRESETS.find((p) => p.id === 'custom')).ok, false);
});

test('voice URL validation normalizes paths and derives locality from the real host', () => {
  const out = validateVoiceConfig({ baseUrl: ' https://voice.example.com/api/v1/// ', model: ' model-1 ', language: 'auto' });
  assert.deepEqual(out, { ok: true, problem: '', baseUrl: 'https://voice.example.com/api/v1', endpoint: 'https://voice.example.com/api/v1/audio/transcriptions', host: 'voice.example.com', local: false, model: 'model-1', language: '' });
  for (const host of ['localhost', '127.0.0.1', '127.2.3.4', '[::1]']) {
    const local = validateVoiceConfig({ baseUrl: `http://${host}:8000/v1` });
    assert.equal(local.ok, true, host);
    assert.equal(local.local, true, host);
  }
  const misleading = validateVoiceConfig({ preset: 'local-openai', baseUrl: 'https://remote.example/v1' });
  assert.equal(misleading.ok, true);
  assert.equal(misleading.local, false);
});

test('voice rejects URL credentials, remote HTTP, non-HTTP schemes, query and fragment', () => {
  for (const baseUrl of ['', 'invalid', 'http://api.example.com/v1', 'http://localhost.example.com/v1', 'http://127.0.0.1.example.com', 'file:///tmp/voice', 'ftp://localhost', 'https://user:secret@example.com/v1', 'https://user@example.com', 'https://api.example.com/v1?key=secret', 'https://api.example.com/v1?', 'https://api.example.com/v1#fragment', 'https://api.example.com/v1#']) {
    const result = validateVoiceConfig({ baseUrl });
    assert.equal(result.ok, false, baseUrl);
    assert.equal(result.endpoint, '', baseUrl);
    assert.doesNotMatch(result.problem, /secret|fragment|user@example/);
  }
});

test('voice model and language are bounded and validated without echoing input', () => {
  for (const model of ['', '   ', 'x'.repeat(201), {}, 12]) assert.equal(validateVoiceConfig({ model }).ok, false);
  assert.equal(validateVoiceConfig({ model: 'x'.repeat(200) }).ok, true);
  for (const language of ['', 'auto', 'zh', 'en', 'eng']) assert.equal(validateVoiceConfig({ language }).ok, true, language);
  for (const language of ['ZH', 'zh-CN', 'english', 'z', '12', ' zh ', null, 1]) assert.equal(validateVoiceConfig({ language }).ok, false, String(language));
});

test('WAV accepts PCM16 mono/stereo and computes duration from frames', () => {
  assert.equal(MAX_AUDIO_BYTES, 4 * 1024 * 1024);
  assert.equal(MAX_DURATION_SECONDS, 60);
  for (const channels of [1, 2]) for (const sampleRate of [8000, 16000, 44100, 48000]) {
    const bytes = wav({ channels, sampleRate, seconds: 0.5 });
    const result = validateWav(bytes);
    assert.equal(result.ok, true);
    assert.equal(result.durationSeconds, 0.5);
    assert.equal(result.channels, channels);
    assert.equal(result.sampleRate, sampleRate);
    assert.deepEqual(result.bytes, new Uint8Array(bytes));
  }
  assert.equal(validateWav(wav({ formatSize: 18 })).ok, true);
});

test('WAV honors Uint8Array offsets and accepts ArrayBuffers but not unrelated input types', () => {
  const recorded = wav({ seconds: 0.25 });
  const container = Buffer.concat([Buffer.alloc(23, 0xff), recorded, Buffer.alloc(11, 0xff)]);
  const sub = new Uint8Array(container.buffer, container.byteOffset + 23, recorded.length);
  const result = validateWav(sub);
  assert.equal(result.ok, true);
  assert.equal(result.bytes.length, recorded.length);
  assert.equal(result.durationSeconds, 0.25);
  const arrayBuffer = Uint8Array.from(recorded).buffer;
  assert.equal(validateWav(arrayBuffer).ok, true);
  for (const audio of [[1, 2, 3], 'data:audio/wav;base64,...', null, new DataView(arrayBuffer), { buffer: arrayBuffer }]) assert.equal(validateWav(audio).ok, false);
});

test('WAV requires real headers, exact RIFF length and supported MIME/encoding', () => {
  assert.equal(validateWav(wav(), 'audio/webm').ok, false);
  assert.equal(validateWav(wav({ format: 3, bits: 32 })).ok, false);
  assert.equal(validateWav(wav({ format: 0xfffe })).ok, false);
  assert.equal(validateWav(wav({ bits: 8 })).ok, false);
  assert.equal(validateWav(wav({ channels: 3 })).ok, false);
  assert.equal(validateWav(wav({ sampleRate: 7999 })).ok, false);
  assert.equal(validateWav(wav({ sampleRate: 48001 })).ok, false);
  const wrongMagic = wav(); wrongMagic.write('RIFX');
  assert.equal(validateWav(wrongMagic).ok, false);
  const wrongSize = wav(); wrongSize.writeUInt32LE(wrongSize.length, 4);
  assert.equal(validateWav(wrongSize).ok, false);
  assert.equal(validateWav(wav().subarray(0, 43)).ok, false);
});

test('WAV refuses forged byte rates, incomplete frames, empty and excessive recordings', () => {
  const forged = wav(); forged.writeUInt32LE(1, 28);
  assert.equal(validateWav(forged).ok, false);
  const aligned = wav({ channels: 2 }); aligned.writeUInt16LE(2, 32);
  assert.equal(validateWav(aligned).ok, false);
  assert.equal(validateWav(wav({ data: Buffer.alloc(3) })).ok, false);
  assert.equal(validateWav(wav({ data: Buffer.alloc(0) })).ok, false);
  assert.equal(validateWav(wav({ seconds: 60 })).ok, true);
  assert.equal(validateWav(wav({ samples: 16000 * 60 + 1 })).ok, false);
  assert.equal(validateWav(wav({ seconds: 65 })).ok, false);
  assert.equal(validateWav(Buffer.alloc(MAX_AUDIO_BYTES + 1)).ok, false);
  // Exactly 4 MiB may contain a short recording plus valid ancillary metadata.
  const base = wav({ seconds: 1 });
  const extra = chunk('JUNK', Buffer.alloc(MAX_AUDIO_BYTES - base.length - 8));
  const limit = wav({ extra: [extra] });
  assert.equal(limit.length, MAX_AUDIO_BYTES);
  assert.equal(validateWav(limit).ok, true);
});

test('WAV validates chunk boundaries, duplicates and mandatory odd-byte padding', () => {
  assert.equal(validateWav(wav({ extra: [chunk('JUNK', Buffer.from([1, 2, 3]))] })).ok, true);
  assert.equal(validateWav(wav({ extra: [chunk('JUNK', Buffer.from([1, 2, 3]), false)] })).ok, false);
  const badPadding = chunk('JUNK', Buffer.from([1])); badPadding[9] = 0xff;
  assert.equal(validateWav(wav({ extra: [badPadding] })).ok, false);
  const duplicateData = wav({ extra: [chunk('data', Buffer.from([0, 0]))] });
  assert.equal(validateWav(duplicateData).ok, false);
  const duplicateFmt = wav({ extra: [wav().subarray(12, 36)] });
  assert.equal(validateWav(duplicateFmt).ok, false);
  const tooLargeChunk = wav(); tooLargeChunk.writeUInt32LE(0xffffffff, 40);
  assert.equal(validateWav(tooLargeChunk).ok, false);
  const shortChunk = Buffer.concat([wav(), Buffer.from('JUN')]); shortChunk.writeUInt32LE(shortChunk.length - 8, 4);
  assert.equal(validateWav(shortChunk).ok, false);
  const noFmt = wav(); noFmt.write('JUNK', 12);
  assert.equal(validateWav(noFmt).ok, false);
  const noData = wav(); noData.write('JUNK', 36);
  assert.equal(validateWav(noData).ok, false);
});
