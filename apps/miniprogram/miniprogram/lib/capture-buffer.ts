export interface CaptureStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
interface Metadata { id: string; next: number; ack: number; bytes: number; finished?: boolean }
/** Small per-frame records avoid repeatedly serializing the entire audio tail. */
export class CaptureBuffer {
  private meta: Metadata | undefined;
  private storage: CaptureStorage;
  private key: string;
  constructor(storage: CaptureStorage, key: string) {
    this.storage = storage; this.key = key;
    const value = JSON.parse(storage.getItem(key) ?? 'null');
    if (value && typeof value.id === 'string' && Number.isSafeInteger(value.next) && Number.isSafeInteger(value.ack)) this.meta = value;
  }
  get id(): string | undefined { return this.meta?.id; }
  get acknowledged(): number { return this.meta?.ack ?? 0; }
  get pendingCount(): number { return this.meta ? this.meta.next - this.meta.ack - 1 : 0; }
  get pendingBytes(): number { return this.meta?.bytes ?? 0; }
  park(): void {
    if (!this.meta) return;
    const parked: Metadata[] = JSON.parse(this.storage.getItem(`${this.key}:parked`) ?? '[]');
    this.storage.setItem(`${this.key}:parked`, JSON.stringify([...parked.filter(m => m.id !== this.meta!.id), this.meta]));
    this.storage.removeItem(this.key); this.meta = undefined;
  }
  restoreParked(): void {
    if (this.meta) return;
    const parked: Metadata[] = JSON.parse(this.storage.getItem(`${this.key}:parked`) ?? '[]');
    const meta = parked.pop();
    if (!meta) return;
    this.storage.setItem(this.key, JSON.stringify(meta)); this.meta = meta;
    this.storage.setItem(`${this.key}:parked`, JSON.stringify(parked));
  }
  get hasParked(): boolean { return JSON.parse(this.storage.getItem(`${this.key}:parked`) ?? '[]').length > 0; }
  nextAfter(sequence: number): { sequence: number; data: string } | undefined {
    if (!this.meta) return;
    const next = Math.max(this.meta.ack + 1, sequence + 1);
    if (next >= this.meta.next) return;
    const data = this.storage.getItem(this.frameKey(next));
    if (data === null) throw new Error('Missing capture audio');
    return { sequence: next, data };
  }
  get finished(): boolean { return this.meta?.finished === true; }
  finish(): void { if (this.meta) { this.meta.finished = true; this.save(); } }
  private frameKey(sequence: number): string { return `${this.key}:${this.meta!.id}:${sequence}`; }
  private save(): void { this.storage.setItem(this.key, JSON.stringify(this.meta)); }
  ready(id: string, sequence: number): void {
    if (this.meta?.id !== id) { this.clear(); this.meta = { id, next: sequence + 1, ack: sequence, bytes: 0 }; this.save(); }
    else this.acknowledge(sequence);
  }
  append(data: string): number {
    const meta = this.meta;
    if (!meta) throw new Error('Capture not ready');
    if (meta.bytes + data.length > 2560000) throw new Error('Capture buffer full');
    const sequence = meta.next;
    this.storage.setItem(this.frameKey(sequence), data);
    meta.next++; meta.bytes += data.length; this.save();
    return sequence;
  }
  acknowledge(sequence: number): void {
    const meta = this.meta;
    if (!meta || sequence <= meta.ack) return;
    for (let n = meta.ack + 1; n <= Math.min(sequence, meta.next - 1); n++) {
      const key = this.frameKey(n); meta.bytes -= this.storage.getItem(key)?.length ?? 0; this.storage.removeItem(key);
    }
    meta.ack = sequence; meta.next = Math.max(meta.next, sequence + 1); meta.bytes = Math.max(0, meta.bytes); this.save();
  }
  pending(): Array<{ sequence: number; data: string }> {
    if (!this.meta) return [];
    const frames = [];
    for (let sequence = this.meta.ack + 1; sequence < this.meta.next; sequence++) {
      const data = this.storage.getItem(this.frameKey(sequence));
      if (data === null) throw new Error('Missing capture audio');
      frames.push({ sequence, data });
    }
    return frames;
  }
  clear(): void {
    if (this.meta) {
      for (let n = this.meta.ack + 1; n < this.meta.next; n++) this.storage.removeItem(this.frameKey(n));
    }
    this.storage.removeItem(this.key); this.meta = undefined;
  }
}

interface CaptureUploadIO {
  writable: () => boolean;
  send: (frame: { sequence: number; data: string }) => void;
  drained: () => void;
  failed: () => void;
}

/** One paced upload path for live and recovered PCM, bounded by durable acknowledgements. */
export class CaptureUpload {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private sent = 0;
  private lastAck = 0;
  private stalledAt = 0;
  private buffer: CaptureBuffer;
  private io: CaptureUploadIO;
  constructor(buffer: CaptureBuffer, io: CaptureUploadIO) { this.buffer = buffer; this.io = io; }

  start(): void { this.stop(); this.active = true; this.sent = this.lastAck = this.buffer.acknowledged; this.stalledAt = Date.now(); this.pump(); }
  stop(): void { this.active = false; clearTimeout(this.timer); this.timer = undefined; }
  wake(): void { if (this.active && !this.timer) this.pump(); }
  private pump(): void {
    if (!this.active) return;
    this.timer = undefined;
    try {
      if (!this.buffer.pendingCount) { this.stalledAt = Date.now(); this.io.drained(); return; }
      if (this.buffer.acknowledged !== this.lastAck) { this.lastAck = this.buffer.acknowledged; this.stalledAt = Date.now(); }
      if (Date.now() - this.stalledAt > 20_000) { this.stop(); this.io.failed(); return; }
      let delay = 100;
      if (this.io.writable() && this.sent - this.buffer.acknowledged < 10) {
        const frame = this.buffer.nextAfter(this.sent);
        if (frame) {
          this.sent = frame.sequence; this.io.send(frame);
          // Base64 PCM16 mono at 16 kHz. Never burst a recovered tail at the ASR provider.
          delay = Math.max(20, Math.ceil((frame.data.length * .75 - (frame.data.endsWith('==') ? 2 : frame.data.endsWith('=') ? 1 : 0)) / 32));
        }
      }
      if (this.active) this.timer = setTimeout(() => this.pump(), delay);
    } catch { this.stop(); this.io.failed(); }
  }
}
