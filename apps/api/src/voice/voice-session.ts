import type { AgentEvent, ChatCompletionRequest, ChatCompletionResponse, VoicePlaybackSnapshot, VoiceRequest, VoiceServerMessage, VoiceState } from '@bio/contracts';
import type { AsrProvider, AsrStream, TtsProvider } from './providers.js';
import { SpokenSegments } from './spoken-segments.js';
import { PlaybackWindow } from './playback-window.js';
import type { DocumentRuntime } from '../agent/document-runtime.js';
import type { DocumentView } from '@bio/contracts';

type Runner = (input: ChatCompletionRequest, emit: (event: AgentEvent) => void, signal: AbortSignal, trigger?: 'call_opening', runtime?: DocumentRuntime) => Promise<ChatCompletionResponse>;
type Payload = VoiceServerMessage extends infer M ? M extends VoiceServerMessage ? Omit<M, 'turnId' | 'elapsedMs'> : never : never;
interface Turn {
  id: string; request: VoiceRequest; abort: AbortController; started: number;
  asr?: AsrStream; endpoint?: ReturnType<typeof setTimeout>; deadline?: ReturnType<typeof setTimeout>;
  task: Promise<void>; state: VoiceState; audioBytes: number;
  speech: AbortController; window: PlaybackWindow; progress: VoicePlaybackSnapshot;
  segments: Array<{ end: number; segmentId: number; messageId: string; text: string }>;
}

/** One connection, one active turn; all late callbacks are scoped to their owning turn. */
export class VoiceSession {
  private current: Turn | undefined;
  private generation = 0;
  private closed = false;
  private lastTask: Promise<void> = Promise.resolve();
  private playbackTurn?: Turn;
  constructor(private asr: AsrProvider, private tts: TtsProvider, private run: Runner,
    private send: (event: VoiceServerMessage) => void, private endpointMs = 2500,
    private observe?: { progress: (value: VoicePlaybackSnapshot) => void; diagnostic: (value: { turnId: string; stage: string; code: string; queuedSamples: number }) => void }) {}

  async listen(id: string, request: VoiceRequest, opening = false, playbackFeedback = false): Promise<void> {
    const generation = ++this.generation;
    this.cancel(undefined, 'superseded');
    // Agent abort is asynchronous; release the conversation lock before reusing it.
    await this.lastTask.catch(() => undefined);
    if (this.closed || generation !== this.generation) return;
    if (this.playbackTurn && (!this.playbackTurn.progress.generated || this.playbackTurn.window.played < this.playbackTurn.window.sent)) this.report(this.playbackTurn, true);
    const turn: Turn = { id, request, abort: new AbortController(), started: performance.now(),
      task: Promise.resolve(), state: 'connecting', audioBytes: 0,
      speech: new AbortController(), window: new PlaybackWindow(playbackFeedback), segments: [],
      progress: { turnId: id, generated: false, sentSamples: 0, playedSamples: 0, interrupted: false } };
    this.current = turn;
    this.state(turn, 'connecting');
    if (opening) {
      turn.task = this.complete(turn, true);
      this.lastTask = turn.task;
      return;
    }
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

  cancel(id?: string, reason = 'user_interrupt'): void {
    const turn = this.current;
    if (!turn || (id && turn.id !== id)) return;
    this.emit(turn, { type: 'cancelled', reason });
    this.cleanup(turn, reason);
    this.current = undefined;
  }
  close(reason = 'connection_closed'): void {
    if (this.playbackTurn) {
      const turn = this.playbackTurn;
      this.report(turn, turn.progress.interrupted || !turn.progress.generated || turn.window.played < turn.window.sent);
    }
    this.closed = true; ++this.generation; this.cancel(undefined, reason);
  }

  playback(id: string, samples: number): void {
    const turn = this.playbackTurn;
    if (!turn || turn.id !== id) return;
    turn.window.acknowledge(samples);
    const completed = turn.segments.filter(part => part.end <= turn.window.played);
    const last = completed.at(-1);
    if (last) {
      const { end: _end, ...played } = last; turn.progress.lastPlayed = played;
      turn.segments = turn.segments.filter(part => part.end > turn.window.played);
    }
    this.report(turn);
  }

  stopPlayback(id: string, code: string): void {
    const turn = this.playbackTurn;
    if (!turn || turn.id !== id) return;
    turn.speech.abort(); this.report(turn, true);
    this.observe?.diagnostic({ turnId: id, stage: 'playback', code, queuedSamples: turn.window.sent - turn.window.played });
  }

  private report(turn: Turn, interrupted = turn.progress.interrupted): void {
    turn.progress = { ...turn.progress, interrupted, sentSamples: turn.window.sent, playedSamples: turn.window.played };
    if (!turn.progress.runId && !turn.progress.generated && !turn.window.sent) return;
    this.observe?.progress({ ...turn.progress });
  }

  updateAttachmentView(id: string, view: { materialId: string; page: number }): void {
    const turn = this.current;
    if (!turn || turn.id !== id || !['connecting', 'listening', 'finalizing'].includes(turn.state)) return;
    if (!turn.request.context?.materialIds?.includes(view.materialId)) return;
    turn.request = { ...turn.request, context: { ...turn.request.context, attachmentView: view } };
  }

  updateDocumentView(id: string, view: DocumentView): void {
    const turn = this.current;
    if (!turn || turn.id !== id || !this.isCurrent(turn)) return;
    turn.request = { ...turn.request, context: { ...turn.request.context, documentView: view } };
  }

  async settled(): Promise<void> { await this.lastTask.catch(() => undefined); }

  private async complete(turn: Turn, opening = false): Promise<void> {
    this.playbackTurn = turn;
    let stage: 'asr' | 'agent' | 'tts' = opening ? 'agent' : 'asr';
    let ttsQueue = Promise.resolve();
    let ttsError: unknown;
    try {
      let text = '';
      if (!opening) {
        text = (await turn.asr!.finish()).trim();
        turn.asr!.close();
        if (!this.isCurrent(turn)) return;
        if (!text) throw new Error('Empty transcription');
        this.emit(turn, { type: 'transcript', text });
      }
      stage = 'agent'; this.state(turn, 'agent');
      const segments = new SpokenSegments();
      let segmentId = 0;
      let queuedCharacters = 0;
      let speechCharacterLimit = 20_000;
      const result = await this.run({ ...turn.request, message: text }, event => {
        if (!this.isCurrent(turn)) return;
        if (event.runId) turn.progress.runId = event.runId;
        // The document store allows 40,000 UTF-16 characters. Leave room for a short introduction.
        if (event.type === 'panel.state.updated' && event.panel.document) speechCharacterLimit = 50_000;
        this.emit(turn, { type: 'agent', event });
        if (event.type !== 'speech.delta' && event.type !== 'speech.completed') return;
        const parts = segments.push(event.messageId, event.type === 'speech.delta' ? event.delta : event.text, event.type === 'speech.completed');
        for (const part of parts) {
          queuedCharacters += part.length;
          if (queuedCharacters > speechCharacterLimit) {
            // A speech budget must never abort the independently persisted Agent response.
            ttsError = new Error('Speech text queue limit'); turn.speech.abort(); return;
          }
          const index = ++segmentId;
          ttsQueue = ttsQueue.then(async () => {
            if (!this.isCurrent(turn) || ttsError || turn.speech.signal.aborted) return;
            await turn.window.ready(turn.speech.signal);
            // Retry only if this segment has emitted no audio; never replay a partial sentence.
            const before = turn.window.sent;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                await this.tts.synthesize(part, turn.speech.signal, async pcm => {
                  if (!this.isCurrent(turn) || turn.speech.signal.aborted) return;
                  for (let offset = 0; offset < pcm.length; offset += 32000) {
                    await turn.window.ready(turn.speech.signal);
                    if (!this.isCurrent(turn)) return;
                    const chunk = pcm.subarray(offset, offset + 32000);
                    turn.window.sent += chunk.length / 2;
                    this.emit(turn, { type: 'audio', segmentId: index, messageId: event.messageId,
                      text: part, data: Buffer.from(chunk).toString('base64'), sampleRate: 16000, endSample: turn.window.sent });
                  }
                });
                break;
              } catch (error) {
                if (attempt || turn.window.sent > before || turn.speech.signal.aborted) throw error;
              }
            }
            if (this.isCurrent(turn)) {
              turn.segments.push({ end: turn.window.sent, segmentId: index, messageId: event.messageId, text: part });
              this.emit(turn, { type: 'segment.end', segmentId: index }); this.playback(turn.id, turn.window.played);
            }
          }).catch(error => { ttsError = error; });
        }
      }, turn.abort.signal, opening ? 'call_opening' : undefined, {
        getView: () => turn.request.context?.documentView,
        beforeShow: async signal => {
          signal?.throwIfAborted();
          await ttsQueue;
          if (ttsError) throw ttsError;
          await turn.window.drained(signal ? AbortSignal.any([turn.speech.signal, signal]) : turn.speech.signal);
          signal?.throwIfAborted();
          if (!this.isCurrent(turn)) throw new Error('Reading cancelled');
        },
      });
      if (!this.isCurrent(turn)) return;
      turn.progress.generated = true; this.report(turn);
      this.emit(turn, { type: 'result', result });
      stage = 'tts'; this.state(turn, 'synthesizing');
      await ttsQueue;
      if (ttsError) throw ttsError;
      if (this.isCurrent(turn)) this.emit(turn, { type: 'done' });
    } catch (error) {
      // Only allowlisted error descriptions are logged; never vendor bodies or user text.
      const message = error instanceof Error ? error.message : '';
      const code = /^(TTS HTTP \d{3}|TTS synthesis failed \(\d+\)|TTS stream incomplete|Invalid TTS PCM|TTS frame too large|Playback acknowledgement timeout)$/.test(message)
        ? message : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? error.name : `${stage}_failed`;
      if (this.isCurrent(turn)) this.observe?.diagnostic({ turnId: turn.id, stage, code, queuedSamples: turn.window.sent - turn.window.played });
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
    this.report(turn, true);
    this.emit(turn, { type: 'error', stage, message, recoverable: true });
    this.emit(turn, { type: 'done' }); this.cleanup(turn, `${stage}_error`);
    if (this.current === turn) this.current = undefined;
  }
  private cleanup(turn: Turn, reason = 'completed'): void {
    clearTimeout(turn.endpoint); clearTimeout(turn.deadline);
    if (reason !== 'completed') this.report(turn, true);
    turn.speech.abort(reason);
    turn.abort.abort(reason); turn.asr?.close();
  }
}
