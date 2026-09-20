import type { VoiceClientMessage, VoiceRequest, VoiceServerMessage } from '@bio/contracts';
import workletUrl from './pcm-worklet.js?url&no-inline';
import { FoxSpeechSignal } from '../../../miniprogram/miniprogram/lib/fox-speech-signal';

type Callbacks = {
  request: () => VoiceRequest;
  start: (turnId: string, request: VoiceRequest) => void;
  event: (event: VoiceServerMessage) => void;
  playback: (playing: boolean, text: string) => void;
  error: (message: string) => void;
  ended: () => void;
  connected?: () => void;
  prepare?: () => Promise<void>;
  microphone?: (enabled: boolean) => void;
  inputLevel?: (level: number) => void;
  listening?: (active: boolean) => void;
  speaking?: (active: boolean) => void;
  microphoneError?: (message: string) => void;
  status?: (message: string) => void;
};

/** Owns microphone, socket, and PCM playback; closing releases all browser resources. */
export class BrowserVoice {
  private socket: WebSocket | undefined;
  private stream: MediaStream | undefined;
  private context?: AudioContext;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private muted?: GainNode;
  private output?: GainNode;
  private playbackAnalyser?: AnalyserNode;
  private playbackSamples = new Float32Array(512);
  private inputAmplitude = 0;
  private inputMeasuredAt = 0;
  private speakerEnabled = true;
  private sources = new Set<AudioBufferSourceNode>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private turnId = '';
  private closed = false;
  private listening = false;
  private callReady = false;
  private ringback: { tones: OscillatorNode[]; gain: GainNode; timer: ReturnType<typeof setTimeout> } | undefined;
  private speechSignal = new FoxSpeechSignal(value => this.callbacks.speaking?.(value));
  private finishing = false;
  private drained = false;
  private nextTime = 0;
  private conversationId?: string;
  private callId: string = crypto.randomUUID();
  private micEnabled = true;
  private micGeneration = 0;
  private turnActive = false;
  private submitted = false;
  private confirmed = false;
  private resume = false;
  private reconnects = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private audioFailed = false;
  private queuedBytes = 0;
  private receivedSamples = 0;
  private acknowledgedSamples = 0;
  private readonly storageKey: string;
  private onVisibility = () => { if (document.hidden) { this.callbacks.error('页面进入后台，通话已暂停；已写入的文稿会保留。'); this.close(false, 'page_hidden'); } };
  constructor(private callbacks: Callbacks, storageKey = 'bio-voice-resume') {
    this.storageKey = storageKey;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      if (saved && typeof saved.callId === 'string' && saved.expiresAt > Date.now()) {
        this.callId = saved.callId; this.resume = true;
      }
    } catch { /* Storage is optional; in-memory reconnect still works. */ }
  }

  async start(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('请在 HTTPS 或 localhost 页面使用麦克风。');
      document.addEventListener('visibilitychange', this.onVisibility);
      this.context = new AudioContext();
      this.output = this.context.createGain();
      this.output.gain.value = this.speakerEnabled ? 1 : 0;
      this.output.connect(this.context.destination);
      this.playbackAnalyser = this.context.createAnalyser();
      this.playbackAnalyser.fftSize = 512;
      this.playbackAnalyser.connect(this.output);
      await this.context.resume();
      if (this.closed) return;
      this.startRingback();
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
      this.capture.port.onmessage = event => {
        const ws = this.socket;
        if (this.closed || !ws || ws.readyState !== WebSocket.OPEN) return;
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
        this.inputAmplitude = rms < .008 ? 0 : Math.min(1, rms * 5);
        this.inputMeasuredAt = performance.now();
        this.speechSignal.update(rms, samples.length / 16);
        this.callbacks.inputLevel?.(rms < 0.008 ? 0 : Math.min(4, Math.ceil(rms * 24)));
        ws.send(event.data as ArrayBuffer);
      };
      await this.callbacks.prepare?.();
      if (this.closed) return;
      this.connectSocket();
    } catch (error) {
      if (!this.closed) {
        console.error('Voice startup failed', error);
        const permissionDenied = error instanceof Error && error.name === 'NotAllowedError';
        this.fail(permissionDenied ? '无法开启麦克风，请检查权限后重试。' : '语音连接失败，请重试。');
      }
    }
  }

  private startRingback(): void {
    const context = this.context!;
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(this.output!);
    const tones = [440, 480].map(frequency => {
      const tone = context.createOscillator();
      tone.frequency.value = frequency;
      tone.connect(gain); tone.start();
      return tone;
    });
    const pulse = () => {
      const now = context.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(.025, now + .08);
      gain.gain.setValueAtTime(.025, now + .85);
      gain.gain.linearRampToValueAtTime(0, now + 1);
      if (this.ringback) this.ringback.timer = setTimeout(pulse, 4000);
    };
    this.ringback = { tones, gain, timer: setTimeout(pulse, 0) };
  }
  private stopRingback(): void {
    if (!this.ringback) return;
    const { tones, gain, timer } = this.ringback;
    clearTimeout(timer);
    tones.forEach(tone => { tone.stop(); tone.disconnect(); });
    gain.disconnect(); this.ringback = undefined;
  }

  private connectSocket(): void {
    if (this.closed) return;
    const url = new URL('/api/v1/voice', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const authToken = typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem('bio-auth-token');
    const ws = this.socket = new WebSocket(url, authToken ? ['bio-voice', `bio-auth.${authToken}`] : []);
    this.connectionTimer = setTimeout(() => this.reconnect(ws), 10000);
    ws.onopen = () => {
      if (this.closed || this.socket !== ws) return;
      clearTimeout(this.connectionTimer); this.listen();
    };
    ws.onmessage = event => {
      if (this.closed || this.socket !== ws) return;
      try { this.receive(JSON.parse(String(event.data)) as VoiceServerMessage); }
      catch (error) {
        console.error('Voice receive failed', { callId: this.callId, turnId: this.turnId, name: error instanceof Error ? error.name : 'unknown' });
        this.fail('语音数据处理失败，请重试。');
      }
    };
    ws.onerror = () => this.reconnect(ws);
    ws.onclose = event => {
      if (this.closed || this.socket !== ws) return;
      if (event?.code === 1008 || event?.code === 1000 && ['Call ended', 'Connection replaced'].includes(event.reason)) {
        this.forget(); this.fail('通话已结束或登录已失效，请重新连接。');
      } else this.reconnect(ws);
    };
  }

  private reconnect(ws: WebSocket): void {
    if (this.closed || this.socket !== ws) return;
    clearTimeout(this.connectionTimer);
    this.remember();
    this.send({ type: 'disconnect', turnId: this.turnId || 'disconnect', reason: 'client_error' });
    this.socket = undefined; ws.close();
    this.setListening(false); this.stopAudio(); this.turnActive = false;
    this.callbacks.event({ type: 'cancelled', turnId: this.turnId, elapsedMs: 0, reason: 'connection_lost' });
    if (document.hidden || this.reconnects >= 3) { this.fail('连接暂时中断，重新连接可尝试恢复刚才的对话。'); return; }
    this.resume = true;
    this.callbacks.status?.('连接中断，正在恢复刚才的对话…');
    const delay = [1000, 3000, 7000][this.reconnects++]!;
    this.reconnectTimer = setTimeout(() => this.connectSocket(), delay);
  }

  private remember(): void {
    if (!this.confirmed && !this.resume) return;
    try { sessionStorage.setItem(this.storageKey, JSON.stringify({ callId: this.callId, expiresAt: Date.now() + 180000 })); } catch { /* Optional storage. */ }
  }
  private forget(): void { this.confirmed = false; this.resume = false; try { sessionStorage.removeItem(this.storageKey); } catch { /* Optional storage. */ } }

  private listen(): void {
    if (this.closed) return;
    if (!this.micEnabled || !this.stream || this.turnActive) return;
    this.turnActive = true; this.submitted = false;
    this.stopAudio(); this.drained = false; this.audioFailed = false; this.receivedSamples = 0; this.acknowledgedSamples = 0;
    this.turnId = crypto.randomUUID();
    const request = this.callbacks.request();
    if (this.conversationId) request.conversationId = this.conversationId;
    this.callbacks.start(this.turnId, request);
    this.send({ type: 'listen', turnId: this.turnId, callId: this.callId, resume: this.resume, playbackFeedback: true, request });
  }
  updateAttachmentView(view: { materialId: string; page: number }): void {
    if (!this.closed && this.turnId) this.send({ type: 'attachment.view', turnId: this.turnId, view });
  }
  updateDocumentView(view: import('@bio/contracts').DocumentView): void {
    if (!this.closed && this.turnId) this.send({ type: 'document.view', turnId: this.turnId, view });
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
    if (event.type === 'error') this.stopRingback();
    if (event.type === 'connected') {
      this.callId = event.callId; this.conversationId = event.conversationId;
      this.confirmed = true; this.resume = false; this.reconnects = 0; this.remember();
      if (event.resumed) this.callbacks.status?.('已恢复刚才的对话，可以继续说。');
    }
    if (event.type === 'error' && event.code === 'CALL_BUSY') { if (this.socket) this.reconnect(this.socket); return; }
    if (event.type === 'asr' && this.listening) this.speechSignal.recognize(event.text);
    if (event.type === 'state') {
      if (event.state === 'listening') this.stopRingback();
      this.setListening(this.micEnabled && event.state === 'listening');
      if (event.state === 'listening' && !this.callReady) { this.callReady = true; this.callbacks.connected?.(); }
    }
    if (event.type === 'transcript' || event.type === 'audio' || event.type === 'agent') this.submitted = true;
    if (event.type === 'agent') this.conversationId = event.event.conversationId;
    if (event.type === 'result') this.conversationId = event.result.conversationId;
    if (event.type === 'audio' && !this.audioFailed) {
      this.stopRingback();
      if (!this.callReady) { this.callReady = true; this.callbacks.connected?.(); }
      try { this.enqueue(event); }
      catch (error) {
        const code = error instanceof Error && ['invalid_audio', 'audio_queue_limit'].includes(error.message) ? error.message : 'audio_context_failed';
        console.error('Voice playback failed', { callId: this.callId, turnId: this.turnId, segmentId: event.segmentId, code, queuedBytes: this.queuedBytes });
        this.audioFailed = true; this.stopAudio();
        this.send({ type: 'playback.stop', turnId: this.turnId, code });
        this.callbacks.error('语音播放暂停，文字会继续保留；你可以继续交流。');
      }
    }
    this.callbacks.event(event);
    // A broken ASR connection must not create an automatic open/fail/listen loop.
    if (event.type === 'error' && event.recoverable && event.stage === 'asr') void this.setMicrophone(false);
    if (event.type === 'done') { this.drained = true; this.afterDrain(); }
    if (event.type === 'error' && !event.recoverable) this.close(false);
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
    if (!value) { this.finishing = false; this.callbacks.inputLevel?.(0); this.speechSignal.reset(); }
    this.callbacks.listening?.(value);
    this.listening = value; this.capture?.port.postMessage(value ? 'start' : 'stop');
  }
  /** Sample the currently audible PCM, not queued audio or a synthetic pulse. */
  getMotionLevel(): number {
    if (this.closed) return 0;
    if (this.sources.size && this.playbackAnalyser && this.speakerEnabled) {
      this.playbackAnalyser.getFloatTimeDomainData(this.playbackSamples);
      const rms = Math.sqrt(this.playbackSamples.reduce((sum, value) => sum + value * value, 0) / this.playbackSamples.length);
      return Math.min(1, Math.max(0, rms - .005) * 5);
    }
    return this.listening && performance.now() - this.inputMeasuredAt < 250 ? this.inputAmplitude : 0;
  }
  setSpeaker(enabled: boolean): void {
    this.speakerEnabled = enabled;
    if (this.output) this.output.gain.value = enabled ? 1 : 0;
  }
  private enqueue(event: Extract<VoiceServerMessage, { type: 'audio' }>): void {
    const context = this.context;
    if (!context || event.sampleRate !== 16000 || event.data.length > 100000) throw new Error('invalid_audio');
    const bytes = Uint8Array.from(atob(event.data), value => value.charCodeAt(0));
    if (!bytes.length || bytes.length % 2) throw new Error('invalid_audio');
    if (this.queuedBytes + bytes.length > 2 * 1024 * 1024 || this.sources.size >= 2000) throw new Error('audio_queue_limit');
    const buffer = context.createBuffer(1, bytes.length / 2, event.sampleRate);
    const samples = buffer.getChannelData(0), view = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const start = Math.max(context.currentTime + 0.04, this.nextTime);
    if (start - context.currentTime > 60) throw new Error('audio_queue_limit');
    this.queuedBytes += bytes.length;
    this.receivedSamples += bytes.length / 2;
    const endSample = event.endSample ?? this.receivedSamples;
    this.nextTime = start + buffer.duration;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(this.playbackAnalyser!);
    this.sources.add(source);
    const turnId = this.turnId;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed && turnId === this.turnId && this.sources.has(source)) this.callbacks.playback(true, event.text);
    }, Math.max(0, (start - context.currentTime) * 1000));
    this.timers.add(timer);
    source.onended = () => {
      source.disconnect(); this.sources.delete(source);
      this.queuedBytes -= bytes.length;
      if (!this.closed && turnId === this.turnId && endSample > this.acknowledgedSamples
        && (endSample - this.acknowledgedSamples >= 16000 || !this.sources.size)) {
        this.acknowledgedSamples = endSample;
        this.send({ type: 'playback', turnId, playedSamples: endSample });
      }
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
    this.sources.clear(); this.nextTime = 0; this.queuedBytes = 0; this.callbacks.playback(false, '');
  }
  private send(message: VoiceClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  private fail(message: string): void { if (!this.closed) { this.callbacks.error(message); this.close(false); } }
  close(hangup = true, reason: 'page_hidden' | 'client_error' = 'client_error'): void {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer); clearTimeout(this.connectionTimer);
    if (hangup) this.forget(); else this.remember();
    if (hangup) this.send({ type: 'hangup', turnId: this.turnId || 'hangup' });
    else this.send({ type: 'disconnect', turnId: this.turnId || 'disconnect', reason });
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.closed = true; ++this.micGeneration; this.callbacks.microphone?.(false); this.setListening(false); this.stopAudio();
    this.stopRingback();
    this.capture?.disconnect(); this.source?.disconnect(); this.muted?.disconnect();
    this.playbackAnalyser?.disconnect();
    this.output?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.socket?.close(1000, hangup ? 'user_hangup' : reason); void this.context?.close().catch(() => undefined);
    this.callbacks.ended();
  }
}
