/** Visual activity only: never controls recording or server turn detection. */
export class FoxSpeechSignal {
  private active = false;
  private quietMs = 0;
  private holdMs = 700;
  private transcript = '';
  private changed: (speaking: boolean) => void;
  constructor(changed: (speaking: boolean) => void) { this.changed = changed; }

  update(rms: number, durationMs: number): void {
    this.quietMs = rms >= 0.008 ? 0 : this.quietMs + durationMs;
    if (rms >= 0.008) this.set(true);
    else if (this.quietMs >= this.holdMs) this.set(false);
  }

  recognize(text: string): void {
    if (!text.trim() || text === this.transcript) return;
    this.transcript = text;
    this.quietMs = 0;
    this.holdMs = 1400;
    this.set(true);
  }

  reset(): void { this.quietMs = 0; this.holdMs = 700; this.transcript = ''; this.set(false); }
  private set(value: boolean): void {
    if (this.active === value) return;
    this.active = value;
    this.changed(value);
  }
}
