// Microphone capture stays in this renderer until stop() requests transcription. The caller
// owns the input field: receiving a transcript never submits or executes it here.
const OUTPUT_RATE = 16000;
const MAX_SECONDS = 60;

/** Resample mono PCM using a weighted box filter when reducing the sample rate. */
export function resampleMono(samples, inputRate, outputRate = OUTPUT_RATE) {
  if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0) throw new Error('Invalid audio sample rate');
  const source = samples instanceof Float32Array ? samples : Float32Array.from(samples);
  if (inputRate === outputRate) return source.slice();
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.floor(source.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const start = i * ratio;
    if (ratio < 1) {
      const index = Math.floor(start), fraction = start - index;
      output[i] = source[index] * (1 - fraction) + (source[Math.min(index + 1, source.length - 1)] ?? 0) * fraction;
      continue;
    }
    const end = Math.min(source.length, start + ratio);
    let sum = 0;
    for (let index = Math.floor(start); index < end; index++) {
      const weight = Math.min(end, index + 1) - Math.max(start, index);
      sum += source[index] * weight;
    }
    output[i] = sum / (end - start);
  }
  return output;
}

/** A standard little-endian, mono, signed 16-bit PCM WAV, returned as an IPC-safe buffer. */
export function encodeWav(samples, sampleRate = OUTPUT_RATE) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 384000) throw new Error('Invalid audio sample rate');
  const output = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(output);
  const tag = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, output.byteLength - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return output;
}

function microphoneError(error) {
  const known = {
    NotAllowedError: '没有获得麦克风权限，请在系统设置中允许指点使用麦克风。',
    SecurityError: '系统阻止了麦克风访问，请检查麦克风权限。',
    NotFoundError: '没有找到麦克风，请连接麦克风后重试。',
    NotReadableError: '麦克风暂时无法使用，可能正被其他应用占用。',
    OverconstrainedError: '麦克风不支持所需的录音设置，请更换设备后重试。',
    AbortError: '录音已中断，请重试。',
  };
  return known[error?.name] || error?.message || '语音输入失败，请重试。';
}

export class VoiceInput {
  constructor({ begin, transcribe, cancel, onState = () => {}, onAmplitude = () => {}, onTranscript = () => {},
    mediaDevices = globalThis.navigator?.mediaDevices,
    AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext,
    AudioWorkletNode = globalThis.AudioWorkletNode,
    setTimeout: schedule = globalThis.setTimeout.bind(globalThis), clearTimeout: unschedule = globalThis.clearTimeout.bind(globalThis),
    workletUrl = new URL('./voice-worklet.js', import.meta.url).href } = {}) {
    this.api = { begin, transcribe, cancel };
    this.onState = onState; this.onAmplitude = onAmplitude; this.onTranscript = onTranscript;
    this.mediaDevices = mediaDevices; this.AudioContext = AudioContext; this.AudioWorkletNode = AudioWorkletNode;
    this.schedule = schedule; this.unschedule = unschedule; this.workletUrl = workletUrl;
    this.state = 'idle'; this.session = null; this.destroyed = false;
  }

  current(session) { return !this.destroyed && this.session === session && !session.cancelled; }

  get currentId() { return this.session?.id ?? null; }

  emit(state, session, extra = {}) {
    this.state = state;
    this.onState({ state, ...(session ? { id: session.id ?? null, where: session.where, maxSeconds: session.maxSeconds, elapsedSeconds: session.frames / (session.rate || OUTPUT_RATE) } : {}), ...extra });
  }

  release(session) {
    if (!session.id || session.released) return;
    session.released = true;
    try { this.api.cancel?.(session.id); } catch { /* Cleanup must not leave a local microphone open. */ }
  }

  stopTracks(session) {
    if (session.stoppingTracks) return;
    session.stoppingTracks = true;
    for (const track of session.stream?.getTracks?.() ?? []) {
      try { track.stop(); } catch { /* A device may have disconnected already. */ }
    }
  }

  cleanup(session) {
    if (session.cleanupPromise) return session.cleanupPromise;
    this.unschedule(session.timer);
    this.unschedule(session.flushTimer);
    session.flushResolve?.(); session.flushResolve = null;
    session.captureClosed = true;
    this.stopTracks(session);
    if (session.node) {
      session.node.onaudioprocess = null;
      if (session.node.port) {
        session.node.port.onmessage = null;
        try { session.node.port.close?.(); } catch {}
      }
      try { session.node.disconnect(); } catch {}
    }
    try { session.source?.disconnect(); } catch {}
    const context = session.context;
    session.node = null; session.source = null; session.context = null; session.stream = null;
    session.cleanupPromise = Promise.resolve().then(() => context?.state !== 'closed' ? context?.close() : undefined).catch(() => {});
    return session.cleanupPromise;
  }

  async fail(session, error) {
    this.release(session);
    await this.cleanup(session);
    session.chunks = [];
    if (!this.current(session)) return false;
    this.session = null;
    this.onAmplitude(0);
    this.emit('error', session, { error: microphoneError(error) });
    return false;
  }

  accept(session, input) {
    if (!this.current(session) || session.captureClosed || !input?.length) return;
    const remaining = Math.max(0, Math.floor(session.rate * session.maxSeconds) - session.frames);
    if (!remaining) return;
    const chunk = new Float32Array(input.subarray ? input.subarray(0, remaining) : input.slice(0, remaining));
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (!Number.isFinite(chunk[i])) chunk[i] = 0;
      sum += chunk[i] * chunk[i];
      session.peak = Math.max(session.peak, Math.abs(chunk[i]));
    }
    session.chunks.push(chunk); session.frames += chunk.length;
    if (this.state === 'listening') {
      this.onAmplitude(Math.min(1, Math.sqrt(sum / Math.max(1, chunk.length)) * 4));
      const elapsed = Math.floor(session.frames / session.rate);
      if (elapsed !== session.elapsedSent) {
        session.elapsedSent = elapsed;
        this.emit('listening', session);
      }
      if (session.frames >= Math.floor(session.rate * session.maxSeconds)) void this.stop();
    }
  }

  async makeCaptureNode(session) {
    const context = session.context;
    if (context.audioWorklet && this.AudioWorkletNode) {
      try {
        await context.audioWorklet.addModule(this.workletUrl);
        if (!this.current(session)) return null;
        const node = new this.AudioWorkletNode(context, 'zhidian-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = ({ data }) => {
          if (data?.type === 'samples') this.accept(session, data.samples);
          else if (data?.type === 'flushed') {
            this.unschedule(session.flushTimer);
            session.flushResolve?.(); session.flushResolve = null;
          }
        };
        session.worklet = true;
        return node;
      } catch (error) {
        if (!this.current(session)) return null;
        if (!context.createScriptProcessor) throw error;
      }
    }
    if (!context.createScriptProcessor) throw new Error('当前系统不支持录音，请更新应用后重试。');
    // Compatibility fallback for environments that cannot load an AudioWorklet from file://.
    // The output is always silent; microphone audio is never played through the speakers.
    const node = context.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = ({ inputBuffer, outputBuffer }) => {
      for (let c = 0; c < outputBuffer.numberOfChannels; c++) outputBuffer.getChannelData(c).fill(0);
      this.accept(session, inputBuffer.getChannelData(0));
    };
    return node;
  }

  async start() {
    if (this.destroyed || ['starting', 'listening', 'transcribing'].includes(this.state)) return false;
    const session = { chunks: [], frames: 0, peak: 0, maxSeconds: MAX_SECONDS, where: '', elapsedSent: 0, cancelled: false };
    this.session = session;
    this.emit('starting', session);
    try {
      const lease = await this.api.begin();
      session.id = lease?.id;
      if (!this.current(session)) { this.release(session); return false; }
      if (!lease?.ok || !session.id) throw new Error(lease?.error || '暂时无法开启语音输入，请检查语音设置。');
      session.where = lease.where || '';
      session.maxSeconds = Math.max(1, Math.min(MAX_SECONDS, Number(lease.maxSeconds) || MAX_SECONDS));
      if (!this.mediaDevices?.getUserMedia || !this.AudioContext) throw new Error('当前系统不支持麦克风录音。');
      const stream = await this.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!this.current(session)) {
        for (const track of stream.getTracks()) track.stop();
        return false;
      }
      session.stream = stream;
      for (const track of stream.getAudioTracks?.() ?? stream.getTracks()) {
        track.addEventListener?.('ended', () => {
          if (this.current(session) && !session.stoppingTracks) void this.fail(session, new Error('麦克风已断开，请重新连接后重试。'));
        }, { once: true });
      }
      try { session.context = new this.AudioContext({ sampleRate: OUTPUT_RATE }); }
      catch (error) {
        if (error?.name !== 'NotSupportedError') throw error;
        session.context = new this.AudioContext();
      }
      session.rate = session.context.sampleRate;
      if (!Number.isFinite(session.rate) || session.rate < 3000 || session.rate > 384000) throw new Error('麦克风采样率无效。');
      if (session.context.state === 'suspended') await session.context.resume();
      if (!this.current(session)) return false;
      const node = await this.makeCaptureNode(session);
      if (!this.current(session) || !node) {
        if (node?.port) { node.port.onmessage = null; try { node.port.close?.(); } catch {} }
        if (node) node.onaudioprocess = null;
        try { node?.disconnect(); } catch {}
        return false;
      }
      session.node = node;
      session.source = session.context.createMediaStreamSource(stream);
      session.source.connect(node);
      node.connect(session.context.destination);
      session.timer = this.schedule(() => { if (this.current(session)) void this.stop(); }, session.maxSeconds * 1000);
      this.onAmplitude(0);
      this.emit('listening', session);
      return true;
    } catch (error) { return this.fail(session, error); }
  }

  flush(session) {
    if (!session.worklet || !session.node?.port || !this.current(session)) return Promise.resolve();
    return new Promise((resolve) => {
      session.flushResolve = resolve;
      session.flushTimer = this.schedule(() => { session.flushResolve = null; resolve(); }, 300);
      try { session.node.port.postMessage({ type: 'flush' }); }
      catch { this.unschedule(session.flushTimer); session.flushResolve = null; resolve(); }
    });
  }

  stop() {
    const session = this.session;
    if (!session || !this.current(session)) return Promise.resolve(false);
    if (this.state === 'starting') { this.cancel(); return Promise.resolve(false); }
    if (this.state === 'transcribing') return session.finishPromise || Promise.resolve(false);
    if (this.state !== 'listening') return Promise.resolve(false);
    this.unschedule(session.timer);
    this.stopTracks(session);
    this.onAmplitude(0);
    this.emit('transcribing', session);
    session.finishPromise = (async () => {
      try {
        await this.flush(session);
        await this.cleanup(session);
        if (!this.current(session)) return false;
        if (session.frames < session.rate * 0.1 || session.peak < 0.0001) throw new Error('没有录到清晰的声音，请靠近麦克风后重试。');
        const samples = new Float32Array(session.frames);
        let offset = 0;
        for (const chunk of session.chunks) { samples.set(chunk, offset); offset += chunk.length; }
        session.chunks = [];
        const audio = encodeWav(resampleMono(samples, session.rate));
        const result = await this.api.transcribe({ id: session.id, audio, mimeType: 'audio/wav' });
        if (!this.current(session)) return false;
        if (!result?.ok) throw new Error(result?.error || '语音识别失败，请重试。');
        const text = String(result.text ?? '').trim();
        if (!text) throw new Error('没有识别到文字，请重新说一遍。');
        this.release(session);
        this.session = null;
        this.emit('success', session);
        this.onTranscript(text);
        return true;
      } catch (error) { return this.fail(session, error); }
    })();
    return session.finishPromise;
  }

  cancel() {
    const session = this.session;
    this.session = null;
    if (session) {
      session.cancelled = true;
      session.chunks = [];
      this.release(session);
      void this.cleanup(session);
    }
    this.onAmplitude(0);
    this.emit('idle');
  }

  destroy() {
    if (this.destroyed) return;
    this.cancel();
    this.destroyed = true;
  }
}
