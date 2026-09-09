import type { VoiceClientMessage, VoiceRequest, VoiceServerMessage } from '@bio/contracts';
import workletUrl from './pcm-worklet.js?url&no-inline';

type Callbacks = {
  request: () => VoiceRequest;
  start: (turnId: string, request: VoiceRequest) => void;
  event: (event: VoiceServerMessage) => void;
  playback: (playing: boolean, text: string) => void;
  error: (message: string) => void;
  ended: () => void;
  connected?: () => void;
  microphone?: (enabled: boolean) => void;
  inputLevel?: (level: number) => void;
  listening?: (active: boolean) => void;
  microphoneError?: (message: string) => void;
};

/** Owns microphone, socket, and PCM playback; closing releases all browser resources. */
export class BrowserVoice {
  private socket?: WebSocket;
  private stream: MediaStream | undefined;
  private context?: AudioContext;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private muted?: GainNode;
  private output?: GainNode;
  private speakerEnabled = true;
  private sources = new Set<AudioBufferSourceNode>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private turnId = '';
  private closed = false;
  private listening = false;
  private finishing = false;
  private drained = false;
  private nextTime = 0;
  private conversationId?: string;
  private micEnabled = true;
  private micGeneration = 0;
  private turnActive = false;
  private submitted = false;
  private onVisibility = () => { if (document.hidden) this.close(); };
  constructor(private callbacks: Callbacks) {}

  async start(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('请在 HTTPS 或 localhost 页面使用麦克风。');
      document.addEventListener('visibilitychange', this.onVisibility);
      this.context = new AudioContext();
      this.output = this.context.createGain();
      this.output.gain.value = this.speakerEnabled ? 1 : 0;
      this.output.connect(this.context.destination);
      await this.context.resume();
      if (this.closed) return;
      const generation = this.micGeneration;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
      if (!this.micEnabled || generation !== this.micGeneration) stream.getTracks().forEach(track => track.stop());
      else this.stream = stream;
      try {
        await this.context.audioWorklet.addModule(workletUrl);
      } catch (error) {
        console.error('Voice capture module failed to load', error);
        throw new Error('语音连接失败，请重试。');
      }
      if (this.closed) return;
      this.capture = new AudioWorkletNode(this.context, 'voice-capture');
      if (this.stream) this.source = this.context.createMediaStreamSource(this.stream);
      this.muted = this.context.createGain(); this.muted.gain.value = 0;
      this.source?.connect(this.capture); this.capture.connect(this.muted); this.muted.connect(this.context.destination);
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
        // Meter only the PCM being accepted for ASR, never reply audio.
        const samples = new Int16Array(event.data as ArrayBuffer);
        let energy = 0;
        for (const sample of samples) energy += (sample / 32768) ** 2;
        const rms = samples.length ? Math.sqrt(energy / samples.length) : 0;
        this.callbacks.inputLevel?.(rms < 0.008 ? 0 : Math.min(4, Math.ceil(rms * 24)));
        ws.send(event.data as ArrayBuffer);
      };
      ws.onopen = () => { if (!this.closed) { this.callbacks.connected?.(); this.listen(); } };
      ws.onmessage = event => {
        try { this.receive(JSON.parse(String(event.data)) as VoiceServerMessage); }
        catch { this.fail('语音数据处理失败，请重试。'); }
      };
      ws.onerror = () => this.fail('暂时无法连接语音服务，请稍后重试。');
      ws.onclose = () => { if (!this.closed) this.fail('语音连接已断开。'); };
    } catch (error) {
      if (!this.closed) {
        console.error('Voice startup failed', error);
        const permissionDenied = error instanceof Error && error.name === 'NotAllowedError';
        this.fail(permissionDenied ? '无法开启麦克风，请检查权限后重试。' : '语音连接失败，请重试。');
      }
    }
  }

  private listen(): void {
    if (this.closed) return;
    if (!this.micEnabled || !this.stream || this.turnActive) return;
    this.turnActive = true; this.submitted = false;
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
    this.turnActive = false; this.setListening(false); this.listen();
  }
  private receive(event: VoiceServerMessage): void {
    if (this.closed || event.turnId !== this.turnId) return;
    if (event.type === 'state') this.setListening(this.micEnabled && event.state === 'listening');
    if (event.type === 'transcript' || event.type === 'audio' || event.type === 'agent') this.submitted = true;
    if (event.type === 'agent') this.conversationId = event.event.conversationId;
    if (event.type === 'result') this.conversationId = event.result.conversationId;
    if (event.type === 'audio') this.enqueue(event);
    this.callbacks.event(event);
    if (event.type === 'done') { this.drained = true; this.afterDrain(); }
    if (event.type === 'error') this.close();
  }
  async setMicrophone(enabled: boolean): Promise<void> {
    if (this.closed || this.micEnabled === enabled) return;
    this.micEnabled = enabled;
    const generation = ++this.micGeneration;
    this.callbacks.microphone?.(enabled);
    if (!enabled) {
      this.setListening(false);
      this.source?.disconnect();
      this.stream?.getTracks().forEach(track => track.stop());
      this.stream = undefined;
      if (!this.submitted && this.turnId) {
        this.send({ type: 'cancel', turnId: this.turnId });
        this.callbacks.event({ type: 'cancelled', turnId: this.turnId, elapsedMs: 0 });
        this.turnId = ''; this.turnActive = false;
      }
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.closed || !this.micEnabled || generation !== this.micGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      if (this.capture && this.context) {
        this.source = this.context.createMediaStreamSource(stream); this.source.connect(this.capture);
      }
      if (this.socket?.readyState === WebSocket.OPEN && !this.turnActive) this.listen();
    } catch {
      if (!this.closed && generation === this.micGeneration) {
        this.micEnabled = false; this.callbacks.microphone?.(false);
        this.callbacks.microphoneError?.('无法开启麦克风，请检查权限。');
      }
    }
  }
  private setListening(value: boolean): void {
    if (this.listening === value) return;
    if (!value) { this.finishing = false; this.callbacks.inputLevel?.(0); }
    this.callbacks.listening?.(value);
    this.listening = value; this.capture?.port.postMessage(value ? 'start' : 'stop');
  }
  setSpeaker(enabled: boolean): void {
    this.speakerEnabled = enabled;
    if (this.output) this.output.gain.value = enabled ? 1 : 0;
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
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(this.output!);
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
    this.drained = false; this.turnActive = false;
    if (!this.micEnabled) return;
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
    this.closed = true; ++this.micGeneration; this.callbacks.microphone?.(false); this.setListening(false); this.stopAudio();
    this.capture?.disconnect(); this.source?.disconnect(); this.muted?.disconnect();
    this.output?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.socket?.close(); void this.context?.close().catch(() => undefined);
    this.callbacks.ended();
  }
}
