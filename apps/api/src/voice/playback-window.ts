/** PCM credit window. The client acknowledges cumulative samples, not wall-clock time. */
export class PlaybackWindow {
  sent = 0;
  played = 0;
  private wake: (() => void) | undefined;
  constructor(private readonly feedback: boolean) {}

  acknowledge(samples: number): void {
    if (!Number.isSafeInteger(samples) || samples < this.played || samples > this.sent) return;
    this.played = samples;
    if (this.sent - this.played <= 8 * 16000) this.wake?.();
  }

  async ready(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.feedback || this.sent - this.played < 20 * 16000) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); this.wake = undefined;
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new Error('Speech cancelled'));
      const timer = setTimeout(() => finish(new Error('Playback acknowledgement timeout')), 45000);
      this.wake = () => finish();
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** A tool may advance the page only after all previously sent PCM was played. */
  async drained(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.sent === this.played) return;
    if (!this.feedback) throw new Error('Page reading requires playback acknowledgements');
    await new Promise<void>((resolve, reject) => {
      let lastPlayed = this.played, progressAt = Date.now();
      const finish = (error?: Error) => {
        clearInterval(timer); signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new Error('Speech cancelled'));
      const timer = setInterval(() => {
        if (this.played >= this.sent) { finish(); return; }
        if (this.played > lastPlayed) { lastPlayed = this.played; progressAt = Date.now(); }
        if (Date.now() - progressAt >= 45000) finish(new Error('Playback acknowledgement timeout'));
      }, 50);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
