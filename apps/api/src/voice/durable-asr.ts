import type { AsrProvider, AsrStream, Recognition } from './providers.js';
import type { CaptureStore } from './capture-store.js';

/** Bounded ASR connections over a durable, ordered audio journal. No Agent calls here. */
export class DurableAsr implements AsrProvider {
  private tasks = new Set<Promise<unknown>>();
  constructor(private provider: AsrProvider, private store: CaptureStore,
    private progress: (type: 'capture.ready' | 'capture.saved', id: string, sequence: number) => void,
    private blockBytes = 30 * 32000, private recovery?: (remainingMs: number, totalMs: number) => void) {}
  async settled(): Promise<void> { while (this.tasks.size) await Promise.allSettled([...this.tasks]); }
  async open(onResult: (result: Recognition) => void, signal: AbortSignal): Promise<AsrStream> {
    const saved = await this.store.load();
    let sequence = saved.sequence, block = saved.block, bytes = 0, queuedBytes = 0;
    let prefix = await this.store.text(saved.id), draft = saved.text;
    let closed = false, finishing = false, live = false, rotating = false;
    let stream: AsrStream;
    let queue = Promise.resolve();
    let checkpoint: ReturnType<typeof setTimeout> | undefined;
    const track = (task: Promise<void>) => {
      this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
      return task;
    };
    const fail = (code = 'capture_persistence_or_stream_failed') => { if (!closed && !signal.aborted) onResult({ text: '', final: false, error: true, code }); };
    const full = () => [prefix, draft].filter(Boolean).join('\n');
    const openStream = async () => this.provider.open(result => {
      if (closed || signal.aborted) return;
      if (result.error) { fail(result.code ?? 'asr_stream_failed'); return; }
      draft = result.text;
      onResult({ text: full(), final: result.final && live && !rotating && !finishing });
      if (!checkpoint && !rotating && !finishing) checkpoint = setTimeout(() => {
        checkpoint = undefined;
        const text = draft, version = block;
        queue = track(queue.then(async () => { if (version === block) await this.store.checkpoint(saved.id, text); }));
        void queue.catch(() => fail());
      }, 5000);
    }, signal);
    const seal = async () => {
      rotating = true;
      clearTimeout(checkpoint); checkpoint = undefined;
      if (!bytes) { stream.close(); rotating = false; return; }
      const text = (await stream.finish()).trim();
      stream.close();
      await this.store.seal(saved.id, block, sequence, text);
      block++; prefix = [prefix, text].filter(Boolean).join('\n'); draft = ''; bytes = 0;
      rotating = false;
    };
    stream = await openStream();
    // Replay only the unsealed tail. Sealed blocks are already canonical text.
    const totalBytes = saved.frames.reduce((sum, frame) => sum + frame.pcm.length, 0);
    let replayed = 0, reported = -1;
    if (totalBytes) this.recovery?.(totalBytes / 32, totalBytes / 32);
    try {
      for (const frame of saved.frames) {
        signal.throwIfAborted();
        if (stream.replay) await stream.replay(frame.pcm); else stream.write(frame.pcm);
        bytes += frame.pcm.length; replayed += frame.pcm.length;
        const second = Math.floor(replayed / 32000);
        if (second !== reported || replayed === totalBytes) {
          reported = second; this.recovery?.((totalBytes - replayed) / 32, totalBytes / 32);
        }
      }
    } catch (error) {
      closed = true; clearTimeout(checkpoint); stream.close(); throw error;
    }
    this.progress('capture.ready', saved.id, sequence);
    if (full()) onResult({ text: full(), final: false });
    const close = () => {
      if (closed) return;
      closed = true; clearTimeout(checkpoint); signal.removeEventListener('abort', close);
      stream.close();
      // Even if recognition failed, audio acknowledged to the client is retained for replay.
      const save = queue.catch(() => undefined).then(() => this.store.checkpoint(saved.id, draft));
      track(save); void save.catch(() => undefined);
    };
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) close();
    return {
      write: (pcm, incoming) => {
        if (closed || finishing) return;
        if (!Number.isSafeInteger(incoming) || incoming! < 1) throw new Error('Capture sequence required');
        queuedBytes += pcm.length;
        if (queuedBytes > 60 * 32000) { queuedBytes -= pcm.length; throw new Error('Capture backlog full'); }
        const copy = Uint8Array.from(pcm);
        queue = track(queue.then(async () => {
          // Writes queued before disconnect may still safely reach the durable journal.
          const added = await this.store.append(saved.id, incoming!, copy);
          this.progress('capture.saved', saved.id, Math.max(sequence, incoming!));
          if (!added) return;
          sequence = incoming!;
          if (closed || signal.aborted) return;
          live = true;
          stream.write(copy); bytes += copy.length;
          if (bytes >= this.blockBytes) {
            await seal();
            if (!closed && !signal.aborted) stream = await openStream();
          }
        }).finally(() => { queuedBytes -= copy.length; }));
        void queue.catch(() => fail());
      },
      finish: async () => {
        finishing = true;
        await queue;
        signal.throwIfAborted();
        await seal();
        return prefix;
      },
      close,
    };
  }
}
