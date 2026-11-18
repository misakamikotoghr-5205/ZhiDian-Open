// The renderer sends a bounded PCM recording. Derive its duration from the actual audio data,
// not renderer metadata or a claimed byte rate, before creating a transcription request.
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 60;

export function validateWav(audio, mimeType = 'audio/wav') {
  const fail = (error) => ({ ok: false, error });
  if (typeof mimeType !== 'string' || mimeType.trim().toLowerCase() !== 'audio/wav') return fail('录音格式必须为 WAV。');
  let bytes;
  try {
    if (audio instanceof Uint8Array) bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
    else if (audio instanceof ArrayBuffer) bytes = new Uint8Array(audio);
    else return fail('录音数据格式不正确。');
  } catch { return fail('录音数据无法读取。'); }
  if (bytes.byteLength > MAX_AUDIO_BYTES) return fail('录音文件超过 4 MiB，请缩短录音。');
  if (bytes.byteLength < 44) return fail('录音文件不完整。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at) => view.getUint16(at, true);
  const u32 = (at) => view.getUint32(at, true);
  const four = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (four(0) !== 'RIFF' || four(8) !== 'WAVE') return fail('录音不是有效的 RIFF/WAVE 文件。');
  if (u32(4) !== bytes.byteLength - 8) return fail('录音文件长度与 WAV 文件头不一致。');
  let fmt = null;
  let dataSize = null;
  let at = 12;
  while (at < bytes.byteLength) {
    if (bytes.byteLength - at < 8) return fail('录音包含不完整的数据块。');
    const id = four(at);
    const size = u32(at + 4);
    const start = at + 8;
    const end = start + size;
    const next = end + (size % 2);
    if (next > bytes.byteLength) return fail('录音数据块长度不正确或缺少填充字节。');
    if (size % 2 && bytes[end] !== 0) return fail('录音数据块的填充字节不正确。');
    if (id === 'fmt ') {
      if (fmt) return fail('录音包含重复的格式数据块。');
      // PCM commonly uses a 16-byte format block, or WAVEFORMATEX with cbSize=0.
      if (size !== 16 && !(size === 18 && u16(start + 16) === 0)) return fail('录音的 WAV 格式数据块不受支持。');
      const format = u16(start);
      const channels = u16(start + 2);
      const sampleRate = u32(start + 4);
      const byteRate = u32(start + 8);
      const blockAlign = u16(start + 12);
      const bits = u16(start + 14);
      if (format !== 1 || bits !== 16) return fail('录音必须使用 16 位 PCM 编码。');
      if (channels !== 1 && channels !== 2) return fail('录音只支持单声道或双声道。');
      if (sampleRate < 8000 || sampleRate > 48000) return fail('录音采样率必须在 8000 到 48000 Hz 之间。');
      if (blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign) return fail('录音文件头的采样参数不一致。');
      fmt = { sampleRate, channels, blockAlign };
    } else if (id === 'data') {
      if (dataSize !== null) return fail('录音包含重复的音频数据块。');
      dataSize = size;
    }
    at = next;
  }
  if (!fmt || dataSize === null) return fail('录音缺少格式或音频数据块。');
  if (!dataSize || dataSize % fmt.blockAlign) return fail('录音为空或音频采样数据不完整。');
  const durationSeconds = dataSize / fmt.blockAlign / fmt.sampleRate;
  if (durationSeconds > MAX_DURATION_SECONDS) return fail('录音不能超过 60 秒，请分段录制。');
  return { ok: true, bytes, durationSeconds, sampleRate: fmt.sampleRate, channels: fmt.channels };
}
