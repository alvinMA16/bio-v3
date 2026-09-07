import type { VoiceClientMessage, VoiceRequest, VoiceServerMessage } from '@bio/contracts';
import workletUrl from './pcm-worklet.js?url';

type Callbacks = {
  request: () => VoiceRequest;
  start: (turnId: string, request: VoiceRequest) => void;
  event: (event: VoiceServerMessage) => void;
  playback: (playing: boolean, text: string) => void;
  error: (message: string) => void;
  ended: () => void;
};

/** Owns microphone, socket, and PCM playback; closing releases all browser resources. */
export class BrowserVoice {
  private socket?: WebSocket;
  private stream?: MediaStream;
  private context?: AudioContext;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private muted?: GainNode;
  private sources = new Set<AudioBufferSourceNode>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private turnId = '';
  private closed = false;
  private listening = false;
  private finishing = false;
  private drained = false;
  private nextTime = 0;
  private conversationId?: string;
  private onVisibility = () => { if (document.hidden) this.close(); };
  constructor(private callbacks: Callbacks) {}

  async start(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('请在 HTTPS 或 localhost 页面使用麦克风。');
      document.addEventListener('visibilitychange', this.onVisibility);
      this.context = new AudioContext();
      await this.context.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      await this.context.audioWorklet.addModule(workletUrl);
      if (this.closed) return;
      this.capture = new AudioWorkletNode(this.context, 'voice-capture');
      this.source = this.context.createMediaStreamSource(stream);
      this.muted = this.context.createGain(); this.muted.gain.value = 0;
      this.source.connect(this.capture); this.capture.connect(this.muted); this.muted.connect(this.context.destination);
      const url = new URL('/api/v1/voice', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = this.socket = new WebSocket(url);
      this.capture.port.onmessage = event => {
        if (this.closed || ws.readyState !== WebSocket.OPEN) return;
        if (event.data?.type === 'flushed') {
          if (this.finishing) { this.finishing = false; this.setListening(false); this.send({ type: 'finish', turnId: this.turnId }); }
          return;
        }
        if (!this.listening) return;
        if (ws.bufferedAmount > 128_000) { this.fail('音频上传拥塞，请检查网络后重试。'); return; }
        ws.send(event.data as ArrayBuffer);
      };
      ws.onopen = () => this.listen();
      ws.onmessage = event => {
        try { this.receive(JSON.parse(String(event.data)) as VoiceServerMessage); }
        catch { this.fail('语音数据处理失败，请重试。'); }
      };
      ws.onerror = () => this.fail('语音服务连接失败，请检查 ASR/TTS 服务配置和网络。');
      ws.onclose = () => { if (!this.closed) this.fail('语音连接已断开。'); };
    } catch (error) { if (!this.closed) this.fail(error instanceof Error ? error.message : '无法启动麦克风。'); }
  }

  private listen(): void {
    if (this.closed) return;
    this.stopAudio(); this.drained = false;
    this.turnId = crypto.randomUUID();
    const request = this.callbacks.request();
    if (this.conversationId) request.conversationId = this.conversationId;
    this.callbacks.start(this.turnId, request);
    this.send({ type: 'listen', turnId: this.turnId, request });
  }
  finish(): void {
    if (!this.listening || this.finishing) return;
    this.finishing = true; this.capture?.port.postMessage('finish');
  }
  interrupt(): void {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'cancel', turnId: this.turnId });
    // Local playback stops immediately; new turn cannot consume old socket events.
    this.callbacks.event({ type: 'cancelled', turnId: this.turnId, elapsedMs: 0 });
    this.setListening(false); this.listen();
  }
  private receive(event: VoiceServerMessage): void {
    if (this.closed || event.turnId !== this.turnId) return;
    if (event.type === 'state') this.setListening(event.state === 'listening');
    if (event.type === 'agent') this.conversationId = event.event.conversationId;
    if (event.type === 'result') this.conversationId = event.result.conversationId;
    if (event.type === 'audio') this.enqueue(event);
    this.callbacks.event(event);
    if (event.type === 'done') { this.drained = true; this.afterDrain(); }
    if (event.type === 'error') this.close();
  }
  private setListening(value: boolean): void {
    if (this.listening === value) return;
    if (!value) this.finishing = false;
    this.listening = value; this.capture?.port.postMessage(value ? 'start' : 'stop');
  }
  private enqueue(event: Extract<VoiceServerMessage, { type: 'audio' }>): void {
    const context = this.context;
    if (!context || event.sampleRate !== 16000) throw new Error('Unsupported audio');
    const bytes = Uint8Array.from(atob(event.data), value => value.charCodeAt(0));
    if (!bytes.length || bytes.length % 2) throw new Error('Invalid PCM');
    const buffer = context.createBuffer(1, bytes.length / 2, event.sampleRate);
    const samples = buffer.getChannelData(0), view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const start = Math.max(context.currentTime + 0.04, this.nextTime);
    if (start - context.currentTime > 60) throw new Error('Playback queue too long');
    this.nextTime = start + buffer.duration;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    this.sources.add(source);
    const turnId = this.turnId;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed && turnId === this.turnId && this.sources.has(source)) this.callbacks.playback(true, event.text);
    }, Math.max(0, (start - context.currentTime) * 1000));
    this.timers.add(timer);
    source.onended = () => {
      source.disconnect(); this.sources.delete(source);
      if (!this.sources.size) { this.callbacks.playback(false, ''); this.afterDrain(); }
    };
    source.start(start);
  }
  private afterDrain(): void {
    if (!this.drained || this.sources.size || this.closed) return;
    this.drained = false;
    // Give React a chance to commit the completed conversation and updated workspace.
    const timer = setTimeout(() => { this.timers.delete(timer); this.listen(); }, 200);
    this.timers.add(timer);
  }
  private stopAudio(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear(); this.nextTime = 0; this.callbacks.playback(false, '');
  }
  private send(message: VoiceClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  private fail(message: string): void { if (!this.closed) { this.callbacks.error(message); this.close(); } }
  close(): void {
    if (this.closed) return;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.closed = true; this.setListening(false); this.stopAudio();
    this.capture?.disconnect(); this.source?.disconnect(); this.muted?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.socket?.close(); void this.context?.close().catch(() => undefined);
    this.callbacks.ended();
  }
}
