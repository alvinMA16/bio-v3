import type { AgentEvent, ChatCompletionRequest, ChatCompletionResponse, VoiceRequest, VoiceServerMessage, VoiceState } from '@bio/contracts';
import type { AsrProvider, AsrStream, TtsProvider } from './providers.js';
import { SpokenSegments } from './spoken-segments.js';

type Runner = (input: ChatCompletionRequest, emit: (event: AgentEvent) => void, signal: AbortSignal) => Promise<ChatCompletionResponse>;
type Payload = VoiceServerMessage extends infer M ? M extends VoiceServerMessage ? Omit<M, 'turnId' | 'elapsedMs'> : never : never;
interface Turn {
  id: string; request: VoiceRequest; abort: AbortController; started: number;
  asr?: AsrStream; endpoint?: ReturnType<typeof setTimeout>; deadline?: ReturnType<typeof setTimeout>;
  task: Promise<void>; state: VoiceState; audioBytes: number;
}

/** One connection, one active turn; all late callbacks are scoped to their owning turn. */
export class VoiceSession {
  private current: Turn | undefined;
  private generation = 0;
  private closed = false;
  private lastTask: Promise<void> = Promise.resolve();
  constructor(private asr: AsrProvider, private tts: TtsProvider, private run: Runner,
    private send: (event: VoiceServerMessage) => void, private endpointMs = 2500) {}

  async listen(id: string, request: VoiceRequest): Promise<void> {
    const generation = ++this.generation;
    this.cancel();
    // Agent abort is asynchronous; release the conversation lock before reusing it.
    await this.lastTask.catch(() => undefined);
    if (this.closed || generation !== this.generation) return;
    const turn: Turn = { id, request, abort: new AbortController(), started: performance.now(),
      task: Promise.resolve(), state: 'connecting', audioBytes: 0 };
    this.current = turn;
    this.state(turn, 'connecting');
    turn.deadline = setTimeout(() => this.fail(turn, 'asr', '录音超过两分钟，请分段讲述。'), 120_000);
    try {
      const stream = await this.asr.open(result => {
        if (!this.isCurrent(turn)) return;
        if (result.error) { this.fail(turn, 'asr', '语音识别连接中断，请重试。'); return; }
        this.emit(turn, { type: 'asr', text: result.text, final: result.final });
        clearTimeout(turn.endpoint);
        if (result.final && result.text.trim() && turn.state === 'listening') {
          turn.endpoint = setTimeout(() => this.finish(turn.id), this.endpointMs);
        }
      }, turn.abort.signal);
      if (!this.isCurrent(turn)) { stream.close(); return; }
      turn.asr = stream;
      this.state(turn, 'listening');
    } catch { this.fail(turn, 'asr', '语音识别连接失败，请检查服务配置后重试。'); }
  }

  audio(pcm: Uint8Array): void {
    const turn = this.current;
    if (!turn || turn.state !== 'listening' || !this.isCurrent(turn)) return;
    if (!pcm.length || pcm.length % 2 || pcm.length > 32_000) { this.fail(turn, 'asr', '音频帧格式无效。'); return; }
    turn.audioBytes += pcm.length;
    if (turn.audioBytes > 16000 * 2 * 120) { this.fail(turn, 'asr', '录音超过两分钟。'); return; }
    try { turn.asr?.write(pcm); } catch { this.fail(turn, 'asr', '语音识别连接中断。'); }
  }

  finish(id: string): void {
    const turn = this.current;
    if (!turn || turn.id !== id || turn.state !== 'listening') return;
    clearTimeout(turn.endpoint); clearTimeout(turn.deadline);
    this.state(turn, 'finalizing');
    turn.task = this.complete(turn);
    this.lastTask = turn.task;
  }

  cancel(id?: string): void {
    const turn = this.current;
    if (!turn || (id && turn.id !== id)) return;
    this.emit(turn, { type: 'cancelled' });
    this.cleanup(turn);
    this.current = undefined;
  }
  close(): void { this.closed = true; ++this.generation; this.cancel(); }

  private async complete(turn: Turn): Promise<void> {
    let stage: 'asr' | 'agent' | 'tts' = 'asr';
    let ttsQueue = Promise.resolve();
    let ttsError: unknown;
    try {
      const text = (await turn.asr!.finish()).trim();
      turn.asr!.close();
      if (!this.isCurrent(turn)) return;
      if (!text) throw new Error('Empty transcription');
      this.emit(turn, { type: 'transcript', text });
      stage = 'agent'; this.state(turn, 'agent');
      const segments = new SpokenSegments();
      let segmentId = 0;
      let queuedCharacters = 0;
      const result = await this.run({ ...turn.request, message: text }, event => {
        if (!this.isCurrent(turn)) return;
        this.emit(turn, { type: 'agent', event });
        if (event.type !== 'speech.delta' && event.type !== 'speech.completed') return;
        const parts = segments.push(event.messageId, event.type === 'speech.delta' ? event.delta : event.text, event.type === 'speech.completed');
        for (const part of parts) {
          queuedCharacters += part.length;
          if (queuedCharacters > 20_000) throw new Error('Speech queue limit exceeded');
          const index = ++segmentId;
          ttsQueue = ttsQueue.then(async () => {
            if (!this.isCurrent(turn) || ttsError) return;
            await this.tts.synthesize(part, turn.abort.signal, pcm => {
              if (this.isCurrent(turn)) this.emit(turn, { type: 'audio', segmentId: index,
                messageId: event.messageId, text: part, data: Buffer.from(pcm).toString('base64'), sampleRate: 16000 });
            });
            if (this.isCurrent(turn)) this.emit(turn, { type: 'segment.end', segmentId: index });
          }).catch(error => { ttsError = error; });
        }
      }, turn.abort.signal);
      if (!this.isCurrent(turn)) return;
      this.emit(turn, { type: 'result', result });
      stage = 'tts'; this.state(turn, 'synthesizing');
      await ttsQueue;
      if (ttsError) throw ttsError;
      if (this.isCurrent(turn)) this.emit(turn, { type: 'done' });
    } catch {
      this.fail(turn, stage, stage === 'asr' ? '没有得到完整识别结果，请重新说一遍。'
        : stage === 'tts' ? '语音播放内容合成失败，文字和面板结果已保留。' : 'Agent 运行失败，请重试。');
    } finally {
      this.cleanup(turn);
      await ttsQueue;
      if (this.current === turn) this.current = undefined;
    }
  }
  private isCurrent(turn: Turn): boolean { return this.current === turn && !turn.abort.signal.aborted && !this.closed; }
  private emit(turn: Turn, payload: Payload): void {
    this.send({ ...payload, turnId: turn.id, elapsedMs: Math.round(performance.now() - turn.started) } as VoiceServerMessage);
  }
  private state(turn: Turn, state: VoiceState): void { turn.state = state; this.emit(turn, { type: 'state', state }); }
  private fail(turn: Turn, stage: 'asr' | 'agent' | 'tts', message: string): void {
    if (!this.isCurrent(turn)) return;
    this.emit(turn, { type: 'error', stage, message }); this.cleanup(turn);
    if (this.current === turn) this.current = undefined;
  }
  private cleanup(turn: Turn): void {
    clearTimeout(turn.endpoint); clearTimeout(turn.deadline);
    turn.abort.abort(); turn.asr?.close();
  }
}
