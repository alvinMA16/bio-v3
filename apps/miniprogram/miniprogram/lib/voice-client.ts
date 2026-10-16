import { CaptureBuffer, CaptureUpload } from './capture-buffer';
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
  private captureBuffer?: CaptureBuffer;
  private durableCapture = false;
  private upload: CaptureUpload | undefined;
  private acceptingAudio = false;
  private finishSent = false;
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
  private playbackBytes = 0;
  private receivedSamples = 0;
  private acknowledgedSamples = 0;
  private audioFailed = false;
  private awaitingRetry = false;
  private resume = false;
  private confirmed = false;
  private reconnects = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private storageKey = `bio-voice-resume:${wx.getStorageSync('bio-account-id') || 'preview'}`;
  constructor(private baseUrl: string, private callbacks: {
    request: () => VoiceRequest; event: (event: VoiceServerMessage) => void;
    playback: (playing: boolean) => void; error: (message: string) => void; ended: () => void;
    speaking?: (speaking: boolean) => void;
  }) {}
  start(): void {
    try { this.captureBuffer = new CaptureBuffer({ getItem: key => wx.getStorageSync(key) || null, setItem: (key, value) => wx.setStorageSync(key, value), removeItem: key => wx.removeStorageSync(key) }, `${this.storageKey}:audio`); } catch { /* Legacy transport remains available. */ }
    if (this.captureBuffer) this.upload = new CaptureUpload(this.captureBuffer, {
      writable: () => !!this.socket && this.queuedBytes < 64_000,
      send: frame => {
        const data = JSON.stringify({ type: 'capture.audio', turnId: this.turnId, ...frame });
        this.queuedBytes += data.length;
        this.socket?.send({ data, fail: () => this.fail('通话已暂停，请重试。'), complete: () => { this.queuedBytes -= data.length; } });
      },
      drained: () => this.uploadDrained(),
      failed: () => this.fail('通话已暂停，请重试。'),
    });
    const saved = wx.getStorageSync(this.storageKey);
    if (saved && typeof saved.callId === 'string' && saved.expiresAt > Date.now()) { this.callId = saved.callId; this.resume = true; }
    wx.authorize({ scope: 'scope.record', success: () => this.connect(), fail: () => this.fail('请允许麦克风权限后重试。') });
  }
  private async connect(): Promise<void> {
    await stopped;
    if (this.closed) return;
    try {
      this.audio ??= wx.createWebAudioContext();
      void this.audio.resume();
      recorderHandlers = { frame: this.onFrame, stop: this.onStop, error: this.onRecorderError };
      const socket = this.socket = wx.connectSocket({ header: wx.getStorageSync('bio-auth-token') ? { Authorization: `Bearer ${wx.getStorageSync('bio-auth-token')}` } : {}, url: `${this.baseUrl.replace(/^http/, 'ws')}/voice`, fail: () => this.fail('无法连接语音服务。') });
      this.connectionTimer = setTimeout(() => this.reconnect(socket), 10000);
      socket.onOpen(() => { if (this.socket === socket && !this.closed) { clearTimeout(this.connectionTimer); this.listen(); } });
      socket.onMessage(({ data }) => {
        if (this.socket !== socket || this.closed) return;
        try { this.receive(JSON.parse(String(data)) as VoiceServerMessage); }
        catch { console.error('Voice receive failed', { callId: this.callId, turnId: this.turnId }); this.fail('暂时无法继续通话，请重试。'); }
      });
      socket.onError(() => this.reconnect(socket));
      socket.onClose(event => {
        if (this.closed || this.socket !== socket) return;
        if (event.code === 1008 || event.code === 1000 && ['Call ended', 'Connection replaced'].includes(event.reason)) { this.confirmed = false; this.resume = false; wx.removeStorageSync(this.storageKey); this.fail('通话已结束或已在另一连接恢复。'); }
        else this.reconnect(socket);
      });
    } catch { this.fail('当前微信版本不支持实时语音，请升级后重试。'); }
  }
  private remember(): void {
    if (!this.confirmed && !this.resume) return;
    try { wx.setStorageSync(this.storageKey, { callId: this.callId, expiresAt: Date.now() + 300000 }); } catch { /* Optional cache. */ }
  }
  private reconnect(socket: WechatMiniprogram.SocketTask): void {
    if (this.closed || this.socket !== socket) return;
    clearTimeout(this.connectionTimer); this.remember(); this.upload?.stop(); this.acceptingAudio = false;
    this.socket = undefined;
    socket.send({ data: JSON.stringify({ type: 'disconnect', turnId: this.turnId || 'disconnect', reason: 'client_error' }), fail: () => undefined });
    socket.close({ code: 1000, reason: 'client_error' });
    this.wantRecording = false; this.recording = false; stopRecorder(); this.stopAudio();
    this.callbacks.event({ type: 'cancelled', turnId: this.turnId, elapsedMs: 0, reason: 'connection_lost' });
    if (this.reconnects >= 3) { this.fail('连接中断，重新连接可尝试恢复刚才的对话。'); return; }
    this.resume = true;
    this.reconnectTimer = setTimeout(() => { void this.connect(); }, [1000, 3000, 7000][this.reconnects++]!);
  }
  private listen(): void {
    if (this.closed) return;
    this.awaitingRetry = false; this.finishSent = false; this.acceptingAudio = false; this.upload?.stop();
    this.stopAudio(); this.drained = false; this.audioFailed = false; this.receivedSamples = 0; this.acknowledgedSamples = 0;
    this.turnId = `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const request = this.callbacks.request();
    if (this.conversationId) request.conversationId = this.conversationId;
    this.send({ type: 'listen', turnId: this.turnId, callId: this.callId, resume: this.resume, playbackFeedback: true, durableCapture: !!this.captureBuffer, orderedCapture: true, ...(this.captureBuffer?.id ? { captureId: this.captureBuffer.id } : {}), request });
  }
  private onFrame = ({ frameBuffer }: { frameBuffer: ArrayBuffer }): void => {
    if (this.closed || !this.recording) return;
    const samples = new Int16Array(frameBuffer);
    let energy = 0;
    for (const sample of samples) energy += (sample / 32768) ** 2;
    this.speechSignal.update(samples.length ? Math.sqrt(energy / samples.length) : 0, samples.length / 16);
    if (this.durableCapture) {
      try {
        const data = wx.arrayBufferToBase64(frameBuffer); this.captureBuffer!.append(data);
        this.upload?.wake(); this.remember();
      } catch { this.fail('通话已暂停，请重试。'); }
      return;
    }
    this.queuedBytes += frameBuffer.byteLength;
    if (this.queuedBytes > 128_000) { this.fail('连接不畅，请稍后重试。'); return; }
    this.socket?.send({ data: frameBuffer, fail: () => this.fail('连接不畅，请稍后重试。'), complete: () => { this.queuedBytes -= frameBuffer.byteLength; } });
  };
  private onStop = (expected: boolean): void => {
    this.recording = false;
    this.speechSignal.reset();
    if (this.closed) return;
    if (this.finishing) { this.finishing = false; this.wantRecording = false;
      if (this.durableCapture) { this.captureBuffer?.finish(); this.upload?.wake(); this.uploadDrained(); }
      else this.send({ type: 'finish', turnId: this.turnId }); }
    else if (!expected && this.wantRecording) void this.beginRecording().catch(() => this.fail('无法继续录音。'));
  };
  private onRecorderError = (): void => this.fail('录音失败，请检查麦克风权限。');
  updateAttachmentView(view: { materialId: string; page: number }): void {
    if (!this.closed && this.turnId) this.send({ type: 'attachment.view', turnId: this.turnId, view });
  }
  updateDocumentView(view: import('@bio/contracts').DocumentView): void {
    if (!this.closed && this.turnId) this.send({ type: 'document.view', turnId: this.turnId, view });
  }
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
    if (event.type === 'capture.finish') this.finish();
    if (event.type === 'capture.ready') { this.durableCapture = true; this.captureBuffer!.ready(event.captureId, event.sequence); }
    if (event.type === 'capture.saved' && event.captureId === this.captureBuffer?.id) { this.captureBuffer.acknowledge(event.sequence); this.upload?.wake(); this.uploadDrained(); }
    if (event.type === 'transcript') { this.upload?.stop(); this.captureBuffer?.clear(); this.durableCapture = false; }
    if (event.type === 'connected') {
      this.callId = event.callId; this.conversationId = event.conversationId;
      this.confirmed = true; this.resume = false; this.reconnects = 0; this.remember();
    }
    if (event.type === 'error' && event.code === 'CALL_BUSY') { if (this.socket) this.reconnect(this.socket); return; }
    if (event.type === 'asr' && this.recording) this.speechSignal.recognize(event.text);
    if (event.type === 'state') {
      this.acceptingAudio = event.state === 'listening';
      if (event.state === 'listening' && !this.recording) {
        if (this.durableCapture) {
          if (this.captureBuffer!.pendingCount) this.send({ type: 'capture.sync', turnId: this.turnId, through: this.captureBuffer!.acknowledged + this.captureBuffer!.pendingCount });
          this.upload?.start();
        } else { this.wantRecording = true; void this.beginRecording().catch(() => this.fail('无法启动录音。')); }
      } else if (event.state !== 'listening') {
        this.upload?.stop();
        this.speechSignal.reset();
        this.wantRecording = false; this.recording = false; stopRecorder();
      }
    }
    if (event.type === 'agent') this.conversationId = event.event.conversationId;
    if (event.type === 'result') this.conversationId = event.result.conversationId;
    if (event.type === 'audio' && !this.audioFailed) {
      try { this.enqueue(event); }
      catch {
        console.error('Voice playback failed', { callId: this.callId, turnId: this.turnId, segmentId: event.segmentId, queuedBytes: this.playbackBytes });
        this.audioFailed = true; this.stopAudio();
        this.send({ type: 'playback.stop', turnId: this.turnId, code: 'audio_context_failed' });
        this.callbacks.event({ type: 'error', stage: 'tts', recoverable: true, message: '语音播放暂停，文字会继续保留。', turnId: this.turnId, elapsedMs: event.elapsedMs });
      }
    }
    if (event.type === 'error' && event.recoverable && event.stage === 'asr') {
      this.awaitingRetry = true; this.wantRecording = false; this.recording = false; stopRecorder(); this.speechSignal.reset();
    }
    this.callbacks.event(event);
    if (event.type === 'done') { this.drained = true; this.afterDrain(); }
    if (event.type === 'error' && !event.recoverable) this.close(false);
  }
  private async beginRecording(): Promise<void> {
    const id = this.turnId;
    await stopped;
    if (this.closed || !this.wantRecording || id !== this.turnId || this.recording) return;
    this.recording = true; recorderBusy = true;
    this.recorder.start({ format: 'PCM', sampleRate: 16000, numberOfChannels: 1, frameSize: 4, duration: 600_000 });
  }
  private enqueue(event: Extract<VoiceServerMessage, { type: 'audio' }>): void {
    const audio = this.audio!;
    if (event.data.length > 100000) throw new Error('Invalid audio');
    const bytes = wx.base64ToArrayBuffer(event.data);
    if (!bytes.byteLength || bytes.byteLength % 2 || event.sampleRate !== 16000) throw new Error('Invalid audio');
    if (this.playbackBytes + bytes.byteLength > 2 * 1024 * 1024 || this.sources.size >= 2000) throw new Error('Playback memory limit');
    const buffer = audio.createBuffer(1, bytes.byteLength / 2, 16000);
    const samples = buffer.getChannelData(0), view = new DataView(bytes);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const at = Math.max(audio.currentTime + .04, this.nextTime);
    if (at - audio.currentTime > 60) throw new Error('Playback backlog');
    this.nextTime = at + samples.length / 16000;
    this.playbackBytes += bytes.byteLength;
    this.receivedSamples += samples.length;
    const endSample = event.endSample ?? this.receivedSamples;
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
      this.playbackBytes -= bytes.byteLength;
      if (!this.closed && id === this.turnId && endSample > this.acknowledgedSamples
        && (endSample - this.acknowledgedSamples >= 16000 || !this.sources.size)) {
        this.acknowledgedSamples = endSample;
        this.send({ type: 'playback', turnId: id, playedSamples: endSample });
      }
      if (!this.sources.size) { this.callbacks.playback(false); this.afterDrain(); }
    };
    source.start(at);
  }
  private afterDrain(): void {
    if (!this.drained || this.sources.size || this.closed || this.awaitingRetry) return;
    this.drained = false;
    const timer = setTimeout(() => { this.timers.delete(timer); this.listen(); }, 300);
    this.timers.add(timer);
  }
  private stopAudio(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const source of this.sources) { source.onended = () => undefined; source.stop(); source.disconnect(); }
    this.sources.clear(); this.nextTime = 0; this.playbackBytes = 0; this.callbacks.playback(false);
  }
  private uploadDrained(): void {
    if (this.closed || !this.acceptingAudio || !this.durableCapture || this.captureBuffer?.pendingCount) return;
    if (this.captureBuffer?.finished) {
      if (!this.finishSent) { this.finishSent = true; this.send({ type: 'finish', turnId: this.turnId }); }
    } else { this.wantRecording = true; void this.beginRecording().catch(() => this.fail('无法启动录音。')); }
  }
  private send(message: VoiceClientMessage): void {
    this.socket?.send({ data: JSON.stringify(message), fail: () => this.fail('语音请求发送失败。') });
  }
  private fail(message: string): void { if (!this.closed) { this.callbacks.error(message); this.close(false); } }
  close(hangup = true, reason: 'page_hidden' | 'client_error' = 'client_error'): void {
    if (this.closed) return;
    this.closed = true; this.upload?.stop();
    clearTimeout(this.reconnectTimer); clearTimeout(this.connectionTimer);
    if (hangup) wx.removeStorageSync(this.storageKey); else this.remember();
    if (hangup) this.send({ type: 'hangup', turnId: this.turnId || 'hangup' });
    else this.send({ type: 'disconnect', turnId: this.turnId || 'disconnect', reason });
    this.wantRecording = false; this.recording = false; stopRecorder();
    this.speechSignal.reset();
    if (recorderHandlers?.frame === this.onFrame) recorderHandlers = undefined;
    this.stopAudio(); void this.audio?.close(); this.socket?.close({ code: 1000, reason: hangup ? 'user_hangup' : reason }); this.callbacks.ended();
  }
}
