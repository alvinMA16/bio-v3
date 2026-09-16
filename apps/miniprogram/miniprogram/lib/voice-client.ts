import type { VoiceClientMessage, VoiceRequest, VoiceServerMessage } from '@bio/contracts';
import { FoxSpeechSignal } from './fox-speech-signal';

let recorderInstance: WechatMiniprogram.RecorderManager | undefined;
let recorderBusy = false;
let stopped = Promise.resolve();
let resolveStopped: (() => void) | undefined;
let stopping = false;
function stopRecorder(): void {
  if (!recorderBusy || stopping) return;
  stopping = true;
  stopped = new Promise(resolve => { resolveStopped = resolve; });
  recorderInstance?.stop();
}
let recorderHandlers: { frame: (event: { frameBuffer: ArrayBuffer }) => void; stop: (expected: boolean) => void; error: () => void } | undefined;
function sharedRecorder(): WechatMiniprogram.RecorderManager {
  if (!recorderInstance) {
    recorderInstance = wx.getRecorderManager();
    recorderInstance.onFrameRecorded(event => recorderHandlers?.frame(event));
    recorderInstance.onStop(() => {
      const expected = stopping;
      recorderBusy = false; stopping = false; resolveStopped?.(); resolveStopped = undefined;
      recorderHandlers?.stop(expected);
    });
    recorderInstance.onError(() => {
      recorderBusy = false; stopping = false; resolveStopped?.(); resolveStopped = undefined;
      recorderHandlers?.error();
    });
  }
  return recorderInstance;
}

/** WeChat transport/audio adapter for the same server-side Agent voice session. */
export class MiniVoiceClient {
  private socket: WechatMiniprogram.SocketTask | undefined;
  private recorder = sharedRecorder();
  private audio: WechatMiniprogram.WebAudioContext | undefined;
  private sources = new Set<WechatMiniprogram.BufferSourceNode>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private turnId = '';
  private closed = false;
  private recording = false;
  private speechSignal = new FoxSpeechSignal(value => this.callbacks.speaking?.(value));
  private wantRecording = false;
  private finishing = false;
  private drained = false;
  private nextTime = 0;
  private conversationId = '';
  private callId = `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private queuedBytes = 0;
  constructor(private baseUrl: string, private callbacks: {
    request: () => VoiceRequest; event: (event: VoiceServerMessage) => void;
    playback: (playing: boolean) => void; error: (message: string) => void; ended: () => void;
    speaking?: (speaking: boolean) => void;
  }) {}
  start(): void {
    wx.authorize({ scope: 'scope.record', success: () => this.connect(), fail: () => this.fail('请允许麦克风权限后重试。') });
  }
  private async connect(): Promise<void> {
    await stopped;
    if (this.closed) return;
    try {
      this.audio = wx.createWebAudioContext();
      void this.audio.resume();
      recorderHandlers = { frame: this.onFrame, stop: this.onStop, error: this.onRecorderError };
      this.socket = wx.connectSocket({ header: wx.getStorageSync('bio-auth-token') ? { Authorization: `Bearer ${wx.getStorageSync('bio-auth-token')}` } : {}, url: `${this.baseUrl.replace(/^http/, 'ws')}/voice`, fail: () => this.fail('无法连接语音服务。') });
      this.socket.onOpen(() => this.listen());
      this.socket.onMessage(({ data }) => {
        try { this.receive(JSON.parse(String(data)) as VoiceServerMessage); }
        catch { this.fail('语音数据处理失败。'); }
      });
      this.socket.onError(() => this.fail('语音连接失败，请检查服务配置。'));
      this.socket.onClose(() => { if (!this.closed) this.fail('语音连接已断开。'); });
    } catch { this.fail('当前微信版本不支持实时语音，请升级后重试。'); }
  }
  private listen(): void {
    if (this.closed) return;
    this.stopAudio(); this.drained = false;
    this.turnId = `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const request = this.callbacks.request();
    if (this.conversationId) request.conversationId = this.conversationId;
    this.send({ type: 'listen', turnId: this.turnId, callId: this.callId, request });
  }
  private onFrame = ({ frameBuffer }: { frameBuffer: ArrayBuffer }): void => {
    if (this.closed || !this.recording) return;
    const samples = new Int16Array(frameBuffer);
    let energy = 0;
    for (const sample of samples) energy += (sample / 32768) ** 2;
    this.speechSignal.update(samples.length ? Math.sqrt(energy / samples.length) : 0, samples.length / 16);
    this.queuedBytes += frameBuffer.byteLength;
    if (this.queuedBytes > 128_000) { this.fail('音频上传拥塞。'); return; }
    this.socket?.send({ data: frameBuffer, fail: () => this.fail('音频上传失败。'), complete: () => { this.queuedBytes -= frameBuffer.byteLength; } });
  };
  private onStop = (expected: boolean): void => {
    this.recording = false;
    this.speechSignal.reset();
    if (this.closed) return;
    if (this.finishing || (!expected && this.wantRecording)) { this.finishing = false; this.wantRecording = false; this.send({ type: 'finish', turnId: this.turnId }); }
  };
  private onRecorderError = (): void => this.fail('录音失败，请检查麦克风权限。');
  finish(): void {
    if (!this.recording || this.finishing) return;
    this.finishing = true; this.wantRecording = false; stopRecorder();
  }
  interrupt(): void {
    if (this.recording || this.closed) return;
    this.send({ type: 'cancel', turnId: this.turnId }); this.listen();
  }
  private receive(event: VoiceServerMessage): void {
    if (this.closed || event.turnId !== this.turnId) return;
    if (event.type === 'asr' && this.recording) this.speechSignal.recognize(event.text);
    if (event.type === 'state') {
      if (event.state === 'listening' && !this.recording) {
        this.wantRecording = true;
        void this.beginRecording().catch(() => this.fail('无法启动录音。'));
      } else if (event.state !== 'listening') {
        this.speechSignal.reset();
        this.wantRecording = false; this.recording = false; stopRecorder();
      }
    }
    if (event.type === 'agent') this.conversationId = event.event.conversationId;
    if (event.type === 'result') this.conversationId = event.result.conversationId;
    if (event.type === 'audio') this.enqueue(event);
    this.callbacks.event(event);
    if (event.type === 'done') { this.drained = true; this.afterDrain(); }
    if (event.type === 'error') this.close();
  }
  private async beginRecording(): Promise<void> {
    const id = this.turnId;
    await stopped;
    if (this.closed || !this.wantRecording || id !== this.turnId || this.recording) return;
    this.recording = true; recorderBusy = true;
    this.recorder.start({ format: 'PCM', sampleRate: 16000, numberOfChannels: 1, frameSize: 4, duration: 120_000 });
  }
  private enqueue(event: Extract<VoiceServerMessage, { type: 'audio' }>): void {
    const audio = this.audio!;
    const bytes = wx.base64ToArrayBuffer(event.data);
    if (!bytes.byteLength || bytes.byteLength % 2 || event.sampleRate !== 16000) throw new Error('Invalid audio');
    const buffer = audio.createBuffer(1, bytes.byteLength / 2, 16000);
    const samples = buffer.getChannelData(0), view = new DataView(bytes);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const at = Math.max(audio.currentTime + .04, this.nextTime);
    if (at - audio.currentTime > 60) throw new Error('Playback backlog');
    this.nextTime = at + samples.length / 16000;
    const source = audio.createBufferSource(); source.buffer = buffer;
    source.connect(audio.destination as WechatMiniprogram.AudioNode);
    this.sources.add(source);
    const id = this.turnId;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed && id === this.turnId && this.sources.has(source)) this.callbacks.playback(true);
    }, Math.max(0, (at - audio.currentTime) * 1000));
    this.timers.add(timer);
    source.onended = () => {
      source.disconnect(); this.sources.delete(source);
      if (!this.sources.size) { this.callbacks.playback(false); this.afterDrain(); }
    };
    source.start(at);
  }
  private afterDrain(): void {
    if (!this.drained || this.sources.size || this.closed) return;
    this.drained = false;
    const timer = setTimeout(() => { this.timers.delete(timer); this.listen(); }, 300);
    this.timers.add(timer);
  }
  private stopAudio(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const source of this.sources) { source.onended = () => undefined; source.stop(); source.disconnect(); }
    this.sources.clear(); this.nextTime = 0; this.callbacks.playback(false);
  }
  private send(message: VoiceClientMessage): void {
    this.socket?.send({ data: JSON.stringify(message), fail: () => this.fail('语音请求发送失败。') });
  }
  private fail(message: string): void { if (!this.closed) { this.callbacks.error(message); this.close(false); } }
  close(hangup = true, reason: 'page_hidden' | 'client_error' = 'client_error'): void {
    if (this.closed) return;
    if (hangup) this.send({ type: 'hangup', turnId: this.turnId || 'hangup' });
    else this.send({ type: 'disconnect', turnId: this.turnId || 'disconnect', reason });
    this.closed = true; this.wantRecording = false; this.recording = false; stopRecorder();
    this.speechSignal.reset();
    if (recorderHandlers?.frame === this.onFrame) recorderHandlers = undefined;
    this.stopAudio(); void this.audio?.close(); this.socket?.close({ code: 1000, reason: hangup ? 'user_hangup' : reason }); this.callbacks.ended();
  }
}
