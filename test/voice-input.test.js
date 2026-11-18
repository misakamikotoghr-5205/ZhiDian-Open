import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { VoiceInput, encodeWav, resampleMono } from '../src/renderer/voice-input.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness(options = {}) {
  const h = { states: [], amplitudes: [], texts: [], cancelled: [], transcribed: [], contexts: [], timers: new Map(), mediaCalls: 0 };
  h.track = { stopped: 0, stop() { this.stopped++; }, addEventListener(name, fn) { this[name] = fn; } };
  h.stream = { getTracks: () => [h.track], getAudioTracks: () => [h.track] };
  let timerId = 0;
  class AudioContext {
    constructor() { this.sampleRate = options.rate || 48000; this.state = 'running'; this.destination = {}; this.closed = 0; h.contexts.push(this); if (options.worklet) this.audioWorklet = { addModule: async () => { if (options.workletError) throw new Error('worklet unavailable'); } }; }
    createMediaStreamSource() { this.source = { connect() {}, disconnect() { this.disconnected = true; } }; return this.source; }
    createScriptProcessor() { this.processor = { connect() {}, disconnect() { this.disconnected = true; }, onaudioprocess: null }; return this.processor; }
    async close() { this.closed++; this.state = 'closed'; }
  }
  class AudioWorkletNode {
    constructor(context) {
      context.processor = this;
      this.port = {
        onmessage: null, closed: false,
        postMessage: ({ type }) => {
          if (type !== 'flush') return;
          queueMicrotask(() => {
            if (options.flushSamples) this.port.onmessage?.({ data: { type: 'samples', samples: options.flushSamples } });
            this.port.onmessage?.({ data: { type: 'flushed' } });
          });
        },
        close() { this.closed = true; },
      };
    }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  h.voice = new VoiceInput({
    begin: options.begin || (async () => ({ ok: true, id: 'lease-1', where: '本机', maxSeconds: options.maxSeconds || 60 })),
    transcribe: async (request) => { h.transcribed.push(request); return options.transcribe ? options.transcribe(request) : { ok: true, text: '  今天整理项目资料  ' }; },
    cancel: (id) => h.cancelled.push(id),
    mediaDevices: { getUserMedia: (...args) => { h.mediaCalls++; return options.getUserMedia ? options.getUserMedia(...args) : Promise.resolve(h.stream); } },
    AudioContext, AudioWorkletNode,
    setTimeout: (fn, ms) => { h.timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: (id) => h.timers.delete(id),
    onState: (state) => h.states.push(state), onAmplitude: (level) => h.amplitudes.push(level), onTranscript: (text) => h.texts.push(text),
  });
  h.feed = (samples) => {
    const node = h.contexts.at(-1).processor;
    if (node.port) node.port.onmessage({ data: { type: 'samples', samples } });
    else {
      const output = new Float32Array(samples.length).fill(1);
      node.onaudioprocess({ inputBuffer: { getChannelData: () => samples }, outputBuffer: { numberOfChannels: 1, getChannelData: () => output } });
      assert.ok(output.every((sample) => sample === 0), 'microphone is never played back');
    }
  };
  return h;
}

test('voice WAV: standard PCM header, signed clipping, finite samples, and exact duration', () => {
  const wav = encodeWav(Float32Array.from([-2, -1, 0, 0.5, 1, 2, NaN]));
  const v = new DataView(wav), text = (from, n) => String.fromCharCode(...new Uint8Array(wav, from, n));
  assert.equal(text(0, 4), 'RIFF'); assert.equal(text(8, 4), 'WAVE'); assert.equal(text(12, 4), 'fmt '); assert.equal(text(36, 4), 'data');
  assert.equal(v.getUint32(4, true), wav.byteLength - 8);
  assert.equal(v.getUint16(20, true), 1); assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000); assert.equal(v.getUint32(28, true), 32000);
  assert.equal(v.getUint16(32, true), 2); assert.equal(v.getUint16(34, true), 16);
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => v.getInt16(44 + i * 2, true)), [-32768, -32768, 0, 16384, 32767, 32767, 0]);
  assert.equal(v.getUint32(40, true), 14);
});

test('voice resampling preserves DC and duration at common device rates and filters alternating samples', () => {
  for (const rate of [16000, 44100, 48000]) {
    const pcm = resampleMono(new Float32Array(rate).fill(0.25), rate);
    assert.equal(pcm.length, 16000);
    assert.ok(pcm.every((sample) => Math.abs(sample - 0.25) < 0.00001));
  }
  assert.deepEqual([...resampleMono(Float32Array.from([1, -1, 1, -1]), 32000)], [0, 0]);
  assert.deepEqual([...resampleMono(Float32Array.from([0, 1]), 8000)], [0, 0.5, 1, 1]);
  assert.throws(() => resampleMono(new Float32Array(1), 0), /sample rate/);
});

test('voice click capture has synchronous states, actual amplitude and one transcript with all resources released', async () => {
  const h = harness();
  const starting = h.voice.start();
  assert.equal(h.voice.state, 'starting');
  assert.equal(await starting, true);
  assert.equal(h.voice.state, 'listening'); assert.equal(h.voice.currentId, 'lease-1');
  h.feed(new Float32Array(4800).fill(0.25));
  assert.ok(h.amplitudes.some((a) => a > 0));
  const stopped = h.voice.stop();
  assert.equal(h.voice.state, 'transcribing');
  assert.equal(await stopped, true);
  assert.equal(h.transcribed.length, 1); assert.equal(h.transcribed[0].mimeType, 'audio/wav');
  assert.equal(h.transcribed[0].audio.byteLength, 44 + 1600 * 2);
  assert.deepEqual(h.texts, ['今天整理项目资料']); assert.equal(h.voice.state, 'success');
  assert.equal(h.voice.currentId, null); assert.equal(h.track.stopped, 1);
  assert.equal(h.contexts[0].closed, 1); assert.equal(h.contexts[0].processor.onaudioprocess, null);
  assert.equal(h.contexts[0].source.disconnected, true); assert.equal(h.timers.size, 0);
  assert.deepEqual(h.cancelled, ['lease-1']);
});

test('voice cancel while permission lease is pending releases the late lease without accessing microphone', async () => {
  const lease = deferred();
  const h = harness({ begin: () => lease.promise });
  const started = h.voice.start();
  h.voice.cancel();
  lease.resolve({ ok: true, id: 'late-lease', where: 'cloud' });
  assert.equal(await started, false);
  assert.equal(h.voice.state, 'idle'); assert.equal(h.mediaCalls, 0);
  assert.deepEqual(h.cancelled, ['late-lease']);
  assert.equal(h.contexts.length, 0); assert.equal(h.transcribed.length, 0);
});

test('voice cancel while getUserMedia is pending immediately releases lease and stops the late stream', async () => {
  const permission = deferred(), entered = deferred();
  const h = harness({ getUserMedia: () => { entered.resolve(); return permission.promise; } });
  const started = h.voice.start();
  await entered.promise;
  h.voice.cancel();
  assert.deepEqual(h.cancelled, ['lease-1']);
  permission.resolve(h.stream);
  assert.equal(await started, false);
  assert.equal(h.track.stopped, 1); assert.equal(h.contexts.length, 0);
  assert.equal(h.voice.state, 'idle'); assert.equal(h.transcribed.length, 0);
});

test('voice stop while starting acts as cancel and never transcribes', async () => {
  const lease = deferred();
  const h = harness({ begin: () => lease.promise });
  const start = h.voice.start();
  assert.equal(await h.voice.stop(), false);
  lease.resolve({ ok: true, id: 'late' });
  await start;
  assert.equal(h.voice.state, 'idle'); assert.deepEqual(h.cancelled, ['late']); assert.equal(h.transcribed.length, 0);
});

test('voice cancelled transcription suppresses late text after the microphone was already closed', async () => {
  const response = deferred(), entered = deferred();
  const h = harness({ transcribe: () => { entered.resolve(); return response.promise; } });
  await h.voice.start(); h.feed(new Float32Array(4800).fill(0.3));
  const stopped = h.voice.stop();
  await entered.promise;
  assert.equal(h.track.stopped, 1); assert.equal(h.contexts[0].closed, 1);
  h.voice.cancel(); response.resolve({ ok: true, text: 'must not be inserted' });
  assert.equal(await stopped, false);
  assert.equal(h.voice.state, 'idle'); assert.deepEqual(h.texts, []); assert.deepEqual(h.cancelled, ['lease-1']);
});

test('voice errors report useful microphone feedback and release authorization', async () => {
  const error = new Error('permission denied'); error.name = 'NotAllowedError';
  const h = harness({ getUserMedia: async () => { throw error; } });
  assert.equal(await h.voice.start(), false);
  assert.equal(h.voice.state, 'error'); assert.match(h.states.at(-1).error, /麦克风权限/);
  assert.deepEqual(h.cancelled, ['lease-1']); assert.equal(h.contexts.length, 0);
});

test('voice silent or empty capture is not uploaded and destroy always closes a recording', async () => {
  const silent = harness();
  await silent.voice.start(); silent.feed(new Float32Array(4800));
  assert.equal(await silent.voice.stop(), false);
  assert.equal(silent.transcribed.length, 0); assert.match(silent.states.at(-1).error, /没有录到/);
  const active = harness(); await active.voice.start(); active.voice.destroy();
  assert.equal(active.track.stopped, 1); assert.equal(active.voice.state, 'idle');
  assert.equal(await active.voice.start(), false); assert.equal(active.timers.size, 0);
});

test('voice captures at most 60 seconds even if a device chunk exceeds the limit', async () => {
  const h = harness({ maxSeconds: 120 });
  await h.voice.start();
  assert.equal([...h.timers.values()][0].ms, 60000);
  h.feed(new Float32Array(48000 * 61).fill(0.1));
  assert.equal(h.voice.state, 'transcribing');
  await h.voice.session.finishPromise;
  assert.equal(h.transcribed.length, 1);
  assert.equal(h.transcribed[0].audio.byteLength, 44 + 16000 * 60 * 2);
  assert.equal(h.track.stopped, 1); assert.equal(h.timers.size, 0);
});

test('voice worklet stop flushes pending samples before closing its port and requesting transcription', async () => {
  const h = harness({ worklet: true, flushSamples: new Float32Array(3000).fill(0.2) });
  await h.voice.start(); h.feed(new Float32Array(3000).fill(0.2));
  const node = h.contexts[0].processor;
  assert.equal(await h.voice.stop(), true);
  assert.equal(h.transcribed[0].audio.byteLength, 44 + 2000 * 2);
  assert.equal(node.port.closed, true); assert.equal(node.port.onmessage, null); assert.equal(h.timers.size, 0);
});

test('voice worklet load failure falls back to silent script processing', async () => {
  const h = harness({ worklet: true, workletError: true });
  assert.equal(await h.voice.start(), true);
  assert.equal(typeof h.contexts[0].processor.onaudioprocess, 'function');
  h.feed(new Float32Array(4800).fill(0.2));
  assert.equal(await h.voice.stop(), true); assert.equal(h.transcribed.length, 1);
});

test('voice AudioWorklet downmixes stereo, emits full chunks and flushes its last partial chunk without audible output', () => {
  let Processor;
  const messages = [];
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage: (data) => messages.push(data) }; } }
  vm.runInNewContext(fs.readFileSync(new URL('../src/renderer/voice-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor, Float32Array, registerProcessor: (_name, cls) => { Processor = cls; },
  });
  const capture = new Processor();
  const left = new Float32Array(2100).fill(0.5), right = new Float32Array(2100).fill(-0.25), output = new Float32Array(2100).fill(1);
  assert.equal(capture.process([[left, right]], [[output]]), true);
  assert.ok(output.every((s) => s === 0));
  assert.equal(messages.length, 1); assert.equal(messages[0].samples.length, 2048);
  assert.ok(messages[0].samples.every((s) => s === 0.125));
  capture.port.onmessage({ data: { type: 'flush' } });
  assert.equal(messages[1].samples.length, 52); assert.equal(messages[2].type, 'flushed');
});
