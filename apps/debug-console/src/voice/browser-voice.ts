import { CaptureBuffer, CaptureUpload } from '../../../miniprogram/miniprogram/lib/capture-buffer';
import { VOICE_RECOVERY_WINDOW_MS } from '@bio/contracts';
import type { VoiceClientMessage, VoiceRequest, VoiceServerMessage } from '@bio/contracts';
import workletUrl from './pcm-worklet.js?url&no-inline';
import { FoxSpeechSignal } from '../../../miniprogram/miniprogram/lib/fox-speech-signal';

type Callbacks = {
  request: () => VoiceRequest;
  start: (turnId: string, request: VoiceRequest) => void;
  event: (event: VoiceServerMessage) => void;
  playback: (playing: boolean, text: string) => void;
  error: (message: string) => void;
  ended: (recoveryUntil?: number) => void;
  connected?: () => void;
  recovering?: () => void;
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
  private captureBuffer: CaptureBuffer | undefined;
  private durableCapture = false;
  private upload?: CaptureUpload;
  private restoring = false;
  private acceptingAudio = false;
  private finishSent = false;
  private readinessTimer?: ReturnType<typeof setTimeout>;
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
  private uiReady = false;
  private captureReady = false;
  private dialingFinished = false;
  private pendingEvents: VoiceServerMessage[] = [];
  private pendingEventBytes = 0;
  private ringback: { tones: OscillatorNode[]; gain: GainNode; startedAt: number; timer: ReturnType<typeof setTimeout> } | undefined;
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
  private recoveryUntil: number | undefined;
  private screenWakeLock: WakeLockSentinel | undefined;
  private wakeLockPending = false;

  /** Optional browser capability; failure must never prevent a voice call. */
  private async keepScreenAwake(): Promise<void> {
    if (this.closed || document.hidden || this.screenWakeLock || this.wakeLockPending || !navigator.wakeLock) return;
    this.wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (this.closed || document.hidden) { await lock.release(); return; }
      this.screenWakeLock = lock;
      lock.addEventListener('release', () => {
        if (this.screenWakeLock === lock) this.screenWakeLock = undefined;
      }, { once: true });
    } catch { /* Unsupported policy, low battery or power saving: recovery remains available. */ }
    finally { this.wakeLockPending = false; }
  }

  private onVisibility = () => {
    if (document.hidden) {
      this.callbacks.error('5 分钟内可继续；已保存的内容会保留。');
      this.close(false, 'page_hidden');
    } else void this.keepScreenAwake();
  };
  constructor(private callbacks: Callbacks, storageKey = 'bio-voice-resume', mode: 'continue' | 'new' | 'saved' = 'continue') {
    this.storageKey = storageKey;
    try {
      this.captureBuffer = new CaptureBuffer(sessionStorage, `${storageKey}:audio`);
      if (mode === 'new') { this.captureBuffer.park(); sessionStorage.removeItem(storageKey); }
      if (mode === 'saved') { this.captureBuffer.park(); this.captureBuffer.restoreParked(); sessionStorage.removeItem(storageKey); }
      this.upload = new CaptureUpload(this.captureBuffer, {
        writable: () => this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 64_000,
        send: frame => this.send({ type: 'capture.audio', turnId: this.turnId, ...frame }),
        drained: () => this.uploadDrained(),
        failed: () => this.fail('录音上传暂时停住，已保存的讲述仍然保留。请继续恢复或开始新通话。', 'upload_stalled'),
      });
    } catch { this.captureBuffer = undefined; /* Start reports unavailable durable storage. */ }
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      if (saved && typeof saved.callId === 'string' && saved.expiresAt > Date.now()) {
        this.callId = saved.callId; this.resume = true; this.recoveryUntil = saved.expiresAt;
      } else if (saved) sessionStorage.removeItem(storageKey);
    } catch { /* Storage is optional; in-memory reconnect still works. */ }
  }

  async start(): Promise<void> {
    try {
      if (!this.captureBuffer) throw new Error('Durable recording storage unavailable');
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('请在 HTTPS 或 localhost 页面使用麦克风。');
      document.addEventListener('visibilitychange', this.onVisibility);
      void this.keepScreenAwake();
      // UI assets, microphone setup and the server opening run concurrently.
      void Promise.resolve().then(() => this.callbacks.prepare?.()).then(() => {
        if (this.closed) return;
        this.uiReady = true; this.flushPreparedEvents();
      }).catch(() => this.fail('通话资源加载失败，请重新呼叫。'));
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
      // Start the opening immediately; capture and assets gate playback, not the server.
      this.connectSocket();
      const workletReady = this.context.audioWorklet.addModule(workletUrl).then(
        () => ({ ok: true as const }), error => ({ ok: false as const, error }),
      );
      const generation = this.micGeneration;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
      if (!this.micEnabled || generation !== this.micGeneration) stream.getTracks().forEach(track => track.stop());
      else this.stream = stream;
      const worklet = await workletReady;
      if (!worklet.ok) {
        console.error('Voice capture module failed to load', worklet.error);
        throw new Error('语音连接失败，请重试。');
      }
      if (this.closed) return;
      this.capture = new AudioWorkletNode(this.context, 'voice-capture');
      if (this.stream) this.source = this.context.createMediaStreamSource(this.stream);
      this.muted = this.context.createGain(); this.muted.gain.value = 0;
      this.source?.connect(this.capture); this.capture.connect(this.muted); this.muted.connect(this.context.destination);
      this.capture.port.onmessage = event => {
        const ws = this.socket;
        if (this.closed) return;
        if (!this.durableCapture && (!ws || ws.readyState !== WebSocket.OPEN)) return;
        if (event.data?.type === 'flushed') {
          if (this.finishing) {
            this.finishing = false; this.setListening(false);
            if (this.durableCapture) { this.captureBuffer?.finish(); this.upload?.wake(); this.uploadDrained(); }
            else this.send({ type: 'finish', turnId: this.turnId });
          }
          return;
        }
        if (!this.listening) return;
        if (!this.durableCapture && ws && ws.bufferedAmount > 128_000) { this.fail('音频上传拥塞，请检查网络后重试。'); return; }
        // Meter only the PCM being accepted for ASR, never reply audio.
        const samples = new Int16Array(event.data as ArrayBuffer);
        let energy = 0;
        for (const sample of samples) energy += (sample / 32768) ** 2;
        const rms = samples.length ? Math.sqrt(energy / samples.length) : 0;
        this.inputAmplitude = rms < .008 ? 0 : Math.min(1, rms * 5);
        this.inputMeasuredAt = performance.now();
        this.speechSignal.update(rms, samples.length / 16);
        this.callbacks.inputLevel?.(rms < 0.008 ? 0 : Math.min(4, Math.ceil(rms * 24)));
        if (this.durableCapture) {
          try {
            const data = btoa(String.fromCharCode(...new Uint8Array(event.data as ArrayBuffer)));
            this.captureBuffer!.append(data);
            this.upload?.wake();
            if (this.captureBuffer!.pendingBytes > 2_400_000) {
              this.setListening(false); this.fail('网络暂时无法保存更多录音，已暂停收音。已保存的讲述可继续恢复。', 'upload_stalled'); return;
            }
            if (!this.recoveryUntil || this.recoveryUntil < Date.now() + VOICE_RECOVERY_WINDOW_MS - 10000) this.remember(true);
          } catch { this.fail('暂时无法安全保存录音，已保存的讲述可在重新连接后继续。', 'storage_unavailable'); }
        } else ws?.send(event.data as ArrayBuffer);
      };
      if (this.closed) return;
      this.captureReady = true;
      this.flushPreparedEvents();
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
    const now = context.currentTime;
    const envelope = new Float32Array(121);
    for (let i = 0; i < envelope.length; i++) {
      const t = i / 120 * .6;
      // Rounded attack, brief crest, then a long, smooth release to exact silence.
      envelope[i] = .025 * (t < .12 ? .5 - .5 * Math.cos(Math.PI * t / .12)
        : t < .22 ? 1 : .5 + .5 * Math.cos(Math.PI * (t - .22) / .38));
    }
    const pulse = (start: number) => gain.gain.setValueCurveAtTime(envelope, start, .6);
    for (let index = 0; index < 3; index++) pulse(now + index * 1.2);
    const finishPulse = () => {
      if (!this.ringback || this.closed) return;
      this.dialingFinished = true;
      this.flushPreparedEvents();
      if (!this.ringback) return;
      // Readiness arriving in the quiet gap can connect immediately. Otherwise
      // add another complete ring, keeping the same cadence until connected.
      this.ringback.timer = setTimeout(() => {
        if (!this.ringback || this.closed) return;
        this.dialingFinished = false;
        this.ringback.startedAt = context.currentTime;
        pulse(context.currentTime);
        this.ringback.timer = setTimeout(finishPulse, 600);
      }, 600);
    };
    this.ringback = { tones, gain, startedAt: now, timer: setTimeout(finishPulse, 3000) };
  }
  /** Audio clock phase drives the portrait and ripples, including extended waits. */
  getDialPhase(): number {
    if (!this.ringback || !this.context || this.closed) return -1;
    return Math.max(0, this.context.currentTime - this.ringback.startedAt) % 1.2;
  }
  private stopRingback(): void {
    if (!this.ringback) return;
    const { tones, gain, timer } = this.ringback;
    clearTimeout(timer);
    const now = this.context!.currentTime;
    if (typeof gain.gain.cancelAndHoldAtTime === 'function') gain.gain.cancelAndHoldAtTime(now);
    else {
      const value = gain.gain.value;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(value, now);
    }
    gain.gain.linearRampToValueAtTime(0, now + .05);
    tones.forEach(tone => {
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
      tone.stop(now + .06);
    });
    this.ringback = undefined;
  }

  private flushPreparedEvents(): void {
    if (this.closed || !this.uiReady || !this.captureReady || !this.dialingFinished) return;
    const events = this.pendingEvents;
    this.pendingEvents = []; this.pendingEventBytes = 0;
    for (const event of events) this.receive(event);
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
      try {
        const message = JSON.parse(String(event.data)) as VoiceServerMessage;
        this.acknowledgePanel(message);
        this.receive(message);
      }
      catch (error) {
        console.error('Voice receive failed', { callId: this.callId, turnId: this.turnId, name: error instanceof Error ? error.name : 'unknown' });
        this.fail('语音数据处理失败，已保存的讲述仍然保留。', 'receive_failed');
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
    this.remember(this.confirmed);
    this.confirmed = false; this.resume = true;
    this.send({ type: 'disconnect', turnId: this.turnId || 'disconnect', reason: 'client_error' });
    this.socket = undefined; ws.close();
    this.pendingEvents = []; this.pendingEventBytes = 0;
    this.upload?.stop(); clearTimeout(this.readinessTimer);
    this.setListening(false); this.callReady = false; this.callbacks.recovering?.();
    this.stopAudio(); this.turnActive = false;
    this.callbacks.event({ type: 'cancelled', turnId: this.turnId, elapsedMs: 0, reason: 'connection_lost' });
    if (document.hidden || this.reconnects >= 3) { this.fail('连接暂时中断，重新连接可尝试恢复刚才的对话。'); return; }
    this.callbacks.status?.('连接中断，正在恢复刚才的对话…');
    const delay = [1000, 3000, 7000][this.reconnects++]!;
    this.reconnectTimer = setTimeout(() => this.connectSocket(), delay);
  }

  private remember(refresh = false): number | undefined {
    if (!this.confirmed && !this.resume) return;
    if (refresh || !this.recoveryUntil) this.recoveryUntil = Date.now() + VOICE_RECOVERY_WINDOW_MS;
    try { sessionStorage.setItem(this.storageKey, JSON.stringify({ callId: this.callId, expiresAt: this.recoveryUntil })); } catch { /* Optional storage. */ }
    return this.recoveryUntil;
  }

  private forget(): void { this.confirmed = false; this.resume = false; try { sessionStorage.removeItem(this.storageKey); } catch { /* Optional storage. */ } }

  private listen(): void {
    if (this.closed) return;
    if (!this.micEnabled || (this.callReady && !this.stream) || this.turnActive) return;
    this.turnActive = true; this.submitted = false; this.finishSent = false;
    this.upload?.stop(); this.acceptingAudio = false; this.setListening(false);
    clearTimeout(this.readinessTimer);
    this.readinessTimer = setTimeout(() => this.fail('语音恢复超时，已保存的讲述仍然保留。可以重试或开始新通话。', 'recovery_timeout'), 120_000);
    this.stopAudio(); this.drained = false; this.audioFailed = false; this.receivedSamples = 0; this.acknowledgedSamples = 0;
    this.turnId = crypto.randomUUID();
    const request = this.callbacks.request();
    if (this.conversationId) request.conversationId = this.conversationId;
    this.callbacks.start(this.turnId, request);
    this.send({ type: 'listen', turnId: this.turnId, callId: this.callId, resume: this.resume, playbackFeedback: true, durableCapture: !!this.captureBuffer, orderedCapture: true, ...(this.captureBuffer?.id ? { captureId: this.captureBuffer.id } : {}), request });
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
  private acknowledgePanel(event: VoiceServerMessage): void {
    if (event.turnId === this.turnId && event.type === 'agent') {
      if (event.event.type === 'panel.state.updated') {
        const view = event.event.panel.documentView;
        if (view?.focus) {
          const script = typeof document !== 'undefined' ? document.querySelector<HTMLScriptElement>('script[type="module"][src]') : null;
          const clientBuild = script?.src.split('/').at(-1)?.split('?')[0];
          // Acknowledge transport before React renders. This is not visibility.
          this.updateDocumentView({ documentId: view.documentId, version: view.version, page: view.page,
            navigation: { requestId: view.focus.requestId, status: 'received', attempts: 0, scrollBefore: 0, scrollAfter: 0,
              ...(clientBuild && /^[a-zA-Z0-9_.-]{1,120}$/.test(clientBuild) ? { clientBuild } : {}) } });
        }
      }
    }
  }

  private receive(event: VoiceServerMessage): void {
    if (this.closed || event.turnId !== this.turnId) return;
    if (event.type === 'error' && event.code !== 'CALL_BUSY') {
      if (!this.uiReady || !this.captureReady || !this.dialingFinished) { this.fail(event.message); return; }
      this.stopRingback();
    }
    if ((!this.uiReady || !this.captureReady || !this.dialingFinished) && event.type !== 'connected' && event.type !== 'error') {
      this.pendingEventBytes += JSON.stringify(event).length * 2;
      if (this.pendingEvents.length >= 2000 || this.pendingEventBytes > 4 * 1024 * 1024) {
        this.fail('开场准备超时，请重新呼叫。'); return;
      }
      this.pendingEvents.push(event); return;
    }
    if (event.type === 'capture.finish') this.finish();
    if (event.type === 'capture.recovering') {
      this.restoring = true; this.setListening(false);
      this.callbacks.status?.(`正在恢复讲述，还需重放约 ${Math.ceil(event.remainingMs / 1000)} 秒录音…`);
    }
    if (event.type === 'capture.ready') {
      this.durableCapture = true;
      this.captureBuffer!.ready(event.captureId, event.sequence);
    }
    if (event.type === 'capture.saved' && event.captureId === this.captureBuffer?.id) {
      this.captureBuffer.acknowledge(event.sequence); this.upload?.wake();
      if (this.restoring && this.captureBuffer.pendingCount) this.callbacks.status?.(`正在补存剩余 ${this.captureBuffer.pendingCount} 段录音…`);
      this.uploadDrained();
    }
    if (event.type === 'transcript') { this.upload?.stop(); this.captureBuffer?.clear(); this.durableCapture = false; }
    if (event.type === 'connected') {
      this.callId = event.callId; this.conversationId = event.conversationId;
      this.confirmed = true; this.resume = false; this.remember();
      this.callbacks.status?.(event.resumed ? '已连上，正在准备恢复讲述…' : '已连上，正在准备语音…');
    }
    if (event.type === 'error' && event.code === 'CALL_BUSY') { if (this.socket) this.reconnect(this.socket); return; }
    if (event.type === 'asr' && this.listening) this.speechSignal.recognize(event.text);
    if (event.type === 'state') {
      this.acceptingAudio = event.state === 'listening';
      if (event.state === 'listening') {
        if (this.durableCapture) {
          this.restoring = !!this.captureBuffer?.pendingCount;
          if (this.restoring) {
            this.callbacks.status?.('正在补存中断前的录音…');
            this.send({ type: 'capture.sync', turnId: this.turnId, through: this.captureBuffer!.acknowledged + this.captureBuffer!.pendingCount });
          }
          this.upload?.start();
        } else { this.mediaReady(); this.setListening(this.micEnabled); }
      } else {
        this.upload?.stop(); this.acceptingAudio = false; this.setListening(false);
      }
    }
    if (event.type === 'transcript' || event.type === 'audio' || event.type === 'agent') this.submitted = true;
    if (event.type === 'agent') this.conversationId = event.event.conversationId;
    if (event.type === 'result') this.conversationId = event.result.conversationId;
    if (event.type === 'audio' && !this.audioFailed) {
      this.stopRingback();
      this.mediaReady();
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
    if (event.type === 'state' && event.state === 'listening' && this.restoring) this.callbacks.status?.('正在补存中断前的录音…');
    if (this.closed) return;
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
  private mediaReady(): void {
    clearTimeout(this.readinessTimer); this.reconnects = 0; this.recoveryUntil = undefined; this.remember();
    this.stopRingback();
    if (!this.callReady) { this.callReady = true; this.callbacks.connected?.(); }
  }
  private uploadDrained(): void {
    if (this.closed || !this.acceptingAudio || !this.durableCapture || this.captureBuffer?.pendingCount) return;
    if (this.captureBuffer?.finished) {
      if (!this.finishSent) { clearTimeout(this.readinessTimer); this.finishSent = true; this.send({ type: 'finish', turnId: this.turnId }); }
    } else if (this.restoring || !this.listening) {
      this.restoring = false; this.mediaReady(); this.callbacks.status?.('正在听你说'); this.setListening(this.micEnabled);
    }
  }
  private send(message: VoiceClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  private fail(message: string, code: 'storage_unavailable' | 'upload_stalled' | 'recovery_timeout' | 'receive_failed' | 'startup_failed' = 'startup_failed'): void {
    if (this.closed) return;
    this.send({ type: 'diagnostic', turnId: this.turnId || 'startup', code, pendingFrames: this.captureBuffer?.pendingCount ?? 0 });
    this.callbacks.error(message); this.close(false);
  }
  close(hangup = true, reason: 'page_hidden' | 'client_error' = 'client_error'): void {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer); clearTimeout(this.connectionTimer); clearTimeout(this.readinessTimer); this.upload?.stop();
    const recoveryUntil = hangup ? undefined : this.remember();
    if (hangup) this.forget();
    if (hangup) this.send({ type: 'hangup', turnId: this.turnId || 'hangup' });
    else this.send({ type: 'disconnect', turnId: this.turnId || 'disconnect', reason });
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.closed = true;
    const lock = this.screenWakeLock; this.screenWakeLock = undefined;
    void lock?.release().catch(() => undefined);
    ++this.micGeneration; this.callbacks.microphone?.(false); this.setListening(false); this.stopAudio();
    this.stopRingback();
    this.pendingEvents = []; this.pendingEventBytes = 0;
    this.capture?.disconnect(); this.source?.disconnect(); this.muted?.disconnect();
    this.playbackAnalyser?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.socket?.close(1000, hangup ? 'user_hangup' : reason);
    // Leave the output connected long enough for the final release on cancel/failure.
    const context = this.context, output = this.output;
    setTimeout(() => { output?.disconnect(); void context?.close().catch(() => undefined); }, 70);
    this.callbacks.ended(recoveryUntil);
  }
}
