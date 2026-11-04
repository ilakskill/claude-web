// cw voice: AudioWorklet processor that turns the microphone's float samples (at the context's
// sample rate) into PCM16 LE mono 16 kHz chunks of 2048 samples (128 ms), posted to the main
// thread as transferable ArrayBuffers. Linear-interpolation resampling with a fractional read
// position carried across process() calls, so any context rate works (48 kHz on most phones).
// 'flush' on the port posts whatever is buffered, then the string 'flushed'.
class CwPcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // eslint-disable-line no-undef -- AudioWorkletGlobalScope
    this.pending = new Float32Array(0);
    this.pos = 0;
    this.out = new Int16Array(2048);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data !== 'flush') return;
      if (this.n > 0) {
        const buf = this.out.slice(0, this.n).buffer;
        this.port.postMessage(buf, [buf]);
        this.n = 0;
      }
      this.port.postMessage('flushed');
    };
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;
    let src = input;
    if (this.pending.length) {
      src = new Float32Array(this.pending.length + input.length);
      src.set(this.pending);
      src.set(input, this.pending.length);
    }
    let pos = this.pos;
    const ratio = this.ratio;
    while (pos + 1 < src.length) {
      const i = pos | 0;
      const f = pos - i;
      const s = src[i] + (src[i + 1] - src[i]) * f;
      this.out[this.n++] = s <= -1 ? -32768 : s >= 1 ? 32767 : (s * 32767) | 0;
      if (this.n === this.out.length) {
        const buf = this.out.buffer;
        this.port.postMessage(buf, [buf]);
        this.out = new Int16Array(2048);
        this.n = 0;
      }
      pos += ratio;
    }
    // pos may point past the end (up to ratio - 1 samples): keep that overshoot as the offset
    // into the next quantum, otherwise one sample is repeated every few quanta.
    const keep = Math.min(pos | 0, src.length);
    this.pending = src.slice(keep); // a copy: `input` is reused by the engine
    this.pos = pos - keep;
    return true;
  }
}
registerProcessor('cw-pcm16', CwPcm16Processor);
