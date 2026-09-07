// Average downsampling with continuous phase across render quanta; PCM16 mono at 16 kHz.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.phase = 0; this.sum = 0; this.count = 0; this.offset = 0;
    this.frame = new Int16Array(1600);
    this.port.onmessage = event => {
      if (event.data === 'finish') {
        if (this.offset) {
          const tail = this.frame.slice(0, this.offset);
          this.port.postMessage(tail.buffer, [tail.buffer]);
        }
        this.enabled = false; this.offset = 0;
        this.port.postMessage({ type: 'flushed' });
        return;
      }
      this.enabled = event.data === 'start';
      this.phase = 0; this.sum = 0; this.count = 0; this.offset = 0;
    };
  }
  process(inputs) {
    if (!this.enabled || !inputs[0]?.[0]) return true;
    for (const sample of inputs[0][0]) {
      this.sum += sample; this.count++; this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const value = Math.max(-1, Math.min(1, this.sum / this.count));
        this.frame[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
        this.sum = 0; this.count = 0;
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(1600); this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
