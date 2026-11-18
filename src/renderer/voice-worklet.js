// A silent AudioWorklet sink that sends bounded mono PCM chunks to the overlay renderer.
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.used = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type !== 'flush') return;
      this.emit();
      this.port.postMessage({ type: 'flushed' });
    };
  }

  emit() {
    if (!this.used) return;
    const samples = this.samples.slice(0, this.used);
    this.used = 0;
    this.port.postMessage({ type: 'samples', samples }, [samples.buffer]);
  }

  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      this.samples[this.used++] = sample / channels.length;
      if (this.used === this.samples.length) this.emit();
    }
    return true;
  }
}
registerProcessor('zhidian-voice-capture', VoiceCaptureProcessor);
