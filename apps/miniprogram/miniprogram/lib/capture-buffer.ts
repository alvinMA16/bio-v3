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
