import { FoxAnimationController, type FoxAnimationState } from '../../lib/fox-animation-controller';
import { MiniVoiceClient } from '../../lib/voice-client';
import { createReceipt, queueReceipt } from '../../lib/session-receipt';
let voiceClient: MiniVoiceClient | null = null;
import type { AgentEvent, PanelState } from '@bio/contracts';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  conversationId: string;
  message: ChatMessage & { createdAt: string };
  finishReason: string | null;
  events?: AgentEvent[];
}

Page({
  animationController: null as FoxAnimationController | null,
  callTimer: null as ReturnType<typeof setInterval> | null,
  callConnectedAt: 0,
  startedAt: 0,
  visibleSince: 0,
  activeMs: 0,
  receiptQueued: false,
  unloaded: false,
  requestTask: null as WechatMiniprogram.RequestTask | null,
  data: {
    callMode: false, callDuration: '未连接', callSubtitle: '',
    actorSrc: '/assets/animations/fox-clerk/blink.webp',
    actorWidth: 400, actorHeight: 300, actorLeft: 0, actorTop: 0,
    voiceActive: false, voiceStatus: '', voiceTranscript: '', audioPlaying: false,
    input: '',
    sending: false,
    conversationId: '',
    messages: [] as ChatMessage[],
    panel: { mode: 'conversation', revision: 0 } as PanelState,
    selectedBlockId: '',
  },

  onLoad(options: Record<string, string | undefined> = {}): void {
    if (options.mode === 'call') this.setData({ callMode: true });
    if (this.data.callMode) {
      wx.setNavigationBarTitle({ title: '与令狸通话' });
      this.animationController = new FoxAnimationController((state: FoxAnimationState) => {
        this.setData({ actorSrc: state.action.src, actorWidth: state.action.columns * 100, actorHeight: state.action.rows * 100, actorLeft: -(state.frame % state.action.columns) * 100, actorTop: -Math.floor(state.frame / state.action.columns) * 100 });
      });
      this.animationController.startAutoCycle();
    }
    this.startedAt = Date.now();
    this.activeMs = 0;
    this.receiptQueued = false;
    this.unloaded = false;
  },

  onReady(): void { if (this.data.callMode) this.startVoice(); },

  onShow(): void { this.visibleSince = Date.now(); this.animationController?.resume(); },

  stopCallTimer(): void {
    if (this.callTimer) clearInterval(this.callTimer);
    this.callTimer = null;
    this.callConnectedAt = 0;
  },

  pauseTimer(): void {
    if (this.visibleSince) this.activeMs += Date.now() - this.visibleSince;
    this.visibleSince = 0;
  },

  leaveChat(): void {
    this.pauseTimer();
    voiceClient?.close();
    this.prepareReceipt();
    wx.navigateBack({ fail: () => { this.receiptQueued = false; this.visibleSince = Date.now(); this.showRequestError('暂时无法返回，请再试一次。'); } });
  },

  startVoice(): void {
    if (this.data.sending || this.data.voiceActive) return;
    this.setData({ voiceActive: true, voiceStatus: '正在连接语音', voiceTranscript: '' });
    voiceClient = new MiniVoiceClient(getApp<IAppOption>().globalData.apiBaseUrl, {
      request: () => {
        const document = this.data.panel.document;
        const selected = document?.blocks.find(block => block.id === this.data.selectedBlockId);
        return {
          ...(this.data.conversationId ? { conversationId: this.data.conversationId } : {}),
          ...(document && selected ? { context: { workspace: { documentId: document.id, version: document.version, selectedBlockId: selected.id, excerpt: selected.text } } } : {}),
        };
      },
      event: event => {
        if (this.unloaded) return;
        if (event.type === 'state') {
          this.animationController?.setActivity({ phase: event.state === 'listening' ? 'listening' : 'processing', notebook: false, reducedMotion: false, speech: 'silent' });
          if (event.state === 'listening' && !this.callConnectedAt) {
            this.callConnectedAt = Date.now();
            this.setData({ callDuration: '00:00' });
            this.callTimer = setInterval(() => {
              const seconds = Math.floor((Date.now() - this.callConnectedAt) / 1000);
              this.setData({ callDuration: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` });
            }, 1000);
          }
        }
        if (event.type === 'state') this.setData({ voiceStatus: ({ connecting: '正在连接语音', listening: '正在听你说', finalizing: '正在确认识别结果', agent: 'Agent 正在处理', synthesizing: '正在合成语音' })[event.state] });
        if (event.type === 'asr') this.setData({ voiceTranscript: event.text });
        if (event.type === 'transcript') this.setData({ voiceTranscript: '', messages: [...this.data.messages, { id: event.turnId, role: 'user', content: event.text }] });
        if (event.type === 'agent') {
          const item = event.event;
          this.setData({ conversationId: item.conversationId });
          if (item.type === 'panel.state.updated') this.setData({ panel: item.panel, selectedBlockId: '' });
          if (item.type === 'speech.delta' || item.type === 'speech.completed') {
            const existing = this.data.messages.find(message => message.id === item.messageId);
            const message: ChatMessage = { id: item.messageId, role: 'assistant', content: item.type === 'speech.completed' ? item.text : (existing?.content ?? '') + item.delta };
            this.setData({ callSubtitle: message.content });
            this.setData({ messages: existing ? this.data.messages.map(value => value.id === message.id ? message : value) : [...this.data.messages, message] });
          }
        }
        if (event.type === 'error') { this.setData({ voiceStatus: event.message }); this.showRequestError(event.message); }
      },
      playback: playing => { if (!this.unloaded) { this.setData({ audioPlaying: playing }); this.animationController?.setActivity({ phase: 'idle', notebook: false, reducedMotion: false, speech: playing ? 'audio' : 'silent' }); } },
      error: message => { if (!this.unloaded) { this.setData({ voiceStatus: message }); this.showRequestError(message); } },
      ended: () => { this.stopCallTimer(); this.animationController?.setActivity({ phase: 'idle', notebook: false, reducedMotion: false, speech: 'silent' }); if (!this.unloaded) this.setData({ voiceActive: false, audioPlaying: false, callDuration: '已断开' }); voiceClient = null; },
    });
    voiceClient.start();
  },
  finishVoice(): void { voiceClient?.finish(); },
  interruptVoice(): void { voiceClient?.interrupt(); },
  stopVoice(): void { voiceClient?.close(); },
  onHide(): void { this.pauseTimer(); voiceClient?.close(); this.stopCallTimer(); this.animationController?.suspend(); },
  onUnload(): void {
    this.pauseTimer();
    this.unloaded = true;
    this.stopCallTimer();
    this.animationController?.destroy();
    this.animationController = null;
    voiceClient?.close();
    this.requestTask?.abort();
    this.prepareReceipt();
  },

  prepareReceipt(): void {
    if (this.receiptQueued) return;
    this.receiptQueued = true;
    const receipt = createReceipt(this.data.messages, this.startedAt, Date.now(), this.activeMs);
    if (receipt) queueReceipt(receipt, this.data.messages);
  },

  onInput(event: WechatMiniprogram.Input): void {
    this.setData({ input: event.detail.value });
  },

  selectBlock(event: WechatMiniprogram.TouchEvent): void {
    this.setData({ selectedBlockId: String(event.currentTarget.dataset.id) });
  },

  sendMessage(): void {
    const message = this.data.input.trim();
    if (!message || this.data.sending || this.data.voiceActive) return;

    const document = this.data.panel.document;
    const selected = document?.blocks.find(block => block.id === this.data.selectedBlockId);

    this.setData({
      input: '',
      sending: true,
      messages: [
        ...this.data.messages,
        { id: `user-${Date.now()}`, role: 'user', content: message },
      ],
    });

    this.requestTask = wx.request<ChatCompletionResponse>({
      url: `${getApp<IAppOption>().globalData.apiBaseUrl}/chat/completions`,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: {
    callMode: false, callDuration: '未连接', callSubtitle: '',
    actorSrc: '/assets/animations/fox-clerk/blink.webp',
    actorWidth: 400, actorHeight: 300, actorLeft: 0, actorTop: 0,
        message,
        ...(document && selected ? { context: { workspace: {
          documentId: document.id, version: document.version, selectedBlockId: selected.id, excerpt: selected.text,
        } } } : {}),
        conversationId: this.data.conversationId || undefined,
      },
      success: ({ data, statusCode }) => {
        if (this.unloaded) return;
        if (statusCode < 200 || statusCode >= 300) {
          this.showRequestError('Agent 暂时无法响应，请稍后重试。');
          return;
        }

        let panel = this.data.panel;
        for (const event of data.events ?? []) {
          if (event.type === 'panel.state.updated') panel = event.panel;
        }
        this.setData({
          panel,
          selectedBlockId: '',
          conversationId: data.conversationId,
          messages: [...this.data.messages, data.message],
        });
      },
      fail: () => { if (!this.unloaded) this.showRequestError('网络连接失败，请稍后重试。'); },
      complete: () => { if (!this.unloaded) this.setData({ sending: false }); },
    });
  },

  showRequestError(message: string): void {
    wx.showToast({ title: message, icon: 'none' });
  },
});
