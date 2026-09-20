import { FOX_ANIMATION_CLIPS, FoxAnimationController, type FoxActionId, type FoxAnimationState } from '../../lib/fox-animation-controller';
import { FoxFrameGate } from '../../lib/fox-frame-gate';
import { requireAccount, handleUnauthorized } from '../../lib/account';
import { MiniVoiceClient } from '../../lib/voice-client';
import { createReceipt, queueReceipt } from '../../lib/session-receipt';
let voiceClient: MiniVoiceClient | null = null;
import type { AgentEvent, PanelState } from '@bio/contracts';

function localPanel(panel: PanelState): PanelState {
  if (!panel.attachment?.url?.startsWith('/api/v1/')) return panel;
  return { ...panel, attachment: { ...panel.attachment, url: getApp<IAppOption>().globalData.apiBaseUrl.replace(/\/api\/v1\/?$/, '') + panel.attachment.url } };
}

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
  attachmentView: undefined as { materialId: string; page: number } | undefined,
  materialIds: [] as string[],
  animationController: null as FoxAnimationController | null,
  frameGate: null as FoxFrameGate | null,
  callTimer: null as ReturnType<typeof setInterval> | null,
  callConnectedAt: 0,
  startedAt: 0,
  visibleSince: 0,
  activeMs: 0,
  receiptQueued: false,
  unloaded: false,
  userSpeaking: false,
  callListening: false,
  requestTask: null as WechatMiniprogram.RequestTask | null,
  data: {
    attachmentFocused: false,
    callMode: false, callDuration: '未连接', callSubtitle: '',
    actorSrc: '/assets/animations/fox-clerk/blink.webp',
    actorSheets: Object.values(FOX_ANIMATION_CLIPS), actorReady: false,
    actorLeft: 0, actorTop: 0,
    voiceActive: false, voiceStatus: '', voiceTranscript: '', audioPlaying: false, agentWorking: false,
    materialTitle: '',
    input: '',
    sending: false,
    conversationId: '',
    messages: [] as ChatMessage[],
    panel: { mode: 'conversation', revision: 0 } as PanelState,
    documentPage: [] as Array<{ blockId: string; kind: string; text: string; start: number; end: number }>,
    documentPageCount: 1,
    selectedBlockId: '',
  },

  async onLoad(options: Record<string, string | undefined> = {}): Promise<void> {
    if (!await requireAccount() || this.unloaded) return;
    if (options.documentId) {
      const document = await new Promise<import('@bio/contracts').PanelDocument | undefined>(resolve => {
        const token = wx.getStorageSync('bio-auth-token');
        wx.request<import('@bio/contracts').PanelDocument>({
          url: `${getApp<IAppOption>().globalData.apiBaseUrl}/agent/documents/${encodeURIComponent(options.documentId!)}`,
          header: token ? { Authorization: `Bearer ${token}` } : {},
          success: response => { handleUnauthorized(response.statusCode); resolve(response.statusCode === 200 ? response.data : undefined); },
          fail: () => resolve(undefined),
        });
      });
      if (this.unloaded) return;
      if (!document) { wx.showToast({ title: '文稿暂时无法打开', icon: 'none' }); return; }
      this.showPanel({ mode: 'editor', revision: 0, document, documentView: { documentId: document.id, version: document.version, page: 1 } });
    }
    this.authenticated = true;
    if (options.materialId) {
      this.materialIds = [options.materialId];
      this.setData({ materialTitle: options.title || '这份资料', input: `我们聊聊《${options.title || '这份资料'}》吧。` });
    }
    if (options.mode === 'call') this.setData({ callMode: true });
    if (this.data.callMode) {
      wx.setNavigationBarTitle({ title: '与令狸通话' });
      this.frameGate = new FoxFrameGate();
      this.animationController = new FoxAnimationController((state: FoxAnimationState) => {
        this.showActorFrame(this.frameGate!.request(state));
      });
      this.animationController.startAutoCycle();
    }
    this.startedAt = Date.now();
    this.activeMs = 0;
    this.receiptQueued = false;
    this.unloaded = false;
    if (this.pageReady && this.data.callMode) this.startVoice();
  },

  authenticated: false,
  hidden: false,
  pageReady: false,
  onReady(): void { this.pageReady = true; if (this.authenticated && this.data.callMode) this.startVoice(); },

  onActorLoaded(event: WechatMiniprogram.CustomEvent): void {
    if (!this.unloaded) this.showActorFrame(this.frameGate?.loaded(event.currentTarget.dataset.action as FoxActionId));
  },

  showActorFrame(state: FoxAnimationState | undefined): void {
    if (!state || this.unloaded) return;
    this.setData({ actorReady: true, actorSrc: state.action.src, actorLeft: -(state.frame % state.action.columns) * 100, actorTop: -Math.floor(state.frame / state.action.columns) * 100 });
  },

  onShow(): void { this.hidden = false; this.visibleSince = Date.now(); this.animationController?.resume(); },

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
    if (!this.authenticated || this.hidden || this.unloaded || this.data.sending || this.data.voiceActive) return;
    this.setData({ voiceActive: true, voiceStatus: '正在连接语音', voiceTranscript: '' });
    this.userSpeaking = false;
    this.callListening = true;
    this.updateCallAnimation();
    voiceClient = new MiniVoiceClient(getApp<IAppOption>().globalData.apiBaseUrl, {
      request: () => {
        const document = this.data.panel.document;
        const selected = document?.blocks.find(block => block.id === this.data.selectedBlockId);
        return {
          ...(this.data.conversationId ? { conversationId: this.data.conversationId } : {}),
          ...(this.materialIds.length ? { provider: 'gemini' as const } : {}),
          context: { ...(this.data.panel.mode === 'editor' && this.data.panel.documentView ? { documentView: this.data.panel.documentView } : {}), ...(this.attachmentView ? { attachmentView: this.attachmentView } : {}), materialIds: this.materialIds, ...(this.materialIds.length ? { scene: 'attachment_conversation' as const } : {}), ...(document && selected ? { workspace: { documentId: document.id, version: document.version, selectedBlockId: selected.id, excerpt: selected.text } } : {}) },
        };
      },
      event: event => {
        if (this.unloaded) return;
        if (event.type === 'state') {
          this.callListening = event.state === 'listening' || event.state === 'connecting';
          this.updateCallAnimation();
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
          if (item.type === 'run.started') this.setData({ agentWorking: true });
          if (['run.completed', 'run.cancelled', 'run.failed'].includes(item.type)) this.setData({ agentWorking: false });
          this.setData({ conversationId: item.conversationId });
          if (item.type === 'panel.state.updated') this.showPanel(item.panel);
          if (item.type === 'speech.delta' || item.type === 'speech.completed') {
            const existing = this.data.messages.find(message => message.id === item.messageId);
            const message: ChatMessage = { id: item.messageId, role: 'assistant', content: item.type === 'speech.completed' ? item.text : (existing?.content ?? '') + item.delta };
            this.setData({ callSubtitle: message.content });
            this.setData({ messages: existing ? this.data.messages.map(value => value.id === message.id ? message : value) : [...this.data.messages, message] });
          }
        }
        if (event.type === 'error') { this.setData({ voiceStatus: event.message }); this.showRequestError(event.message); }
      },
      speaking: speaking => { if (!this.unloaded) { this.userSpeaking = speaking; this.updateCallAnimation(); } },
      playback: playing => { if (!this.unloaded) { this.setData({ audioPlaying: playing }); this.updateCallAnimation(); } },
      error: message => { if (!this.unloaded) { this.setData({ voiceStatus: message }); this.showRequestError(message); } },
      ended: () => { this.stopCallTimer(); this.animationController?.setActivity({ phase: 'idle', notebook: false, reducedMotion: false, speech: 'silent' }); if (!this.unloaded) this.setData({ voiceActive: false, audioPlaying: false, agentWorking: false, callDuration: '已断开' }); voiceClient = null; },
    });
    voiceClient.start();
  },
  updateCallAnimation(): void {
    this.animationController?.setActivity({
      phase: this.userSpeaking ? 'listening' : this.callListening ? 'waiting' : 'processing',
      notebook: true, reducedMotion: false, speech: this.data.audioPlaying ? 'audio' : 'silent',
    });
  },
  finishVoice(): void { voiceClient?.finish(); },
  interruptVoice(): void { voiceClient?.interrupt(); },
  stopVoice(): void { voiceClient?.close(); },
  onHide(): void { this.hidden = true; this.pauseTimer(); voiceClient?.close(false, 'page_hidden'); this.stopCallTimer(); this.animationController?.suspend(); },
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
    if (receipt) queueReceipt(receipt);
  },

  onInput(event: WechatMiniprogram.Input): void {
    this.setData({ input: event.detail.value });
  },

  selectBlock(event: WechatMiniprogram.TouchEvent): void {
    this.setData({ selectedBlockId: String(event.currentTarget.dataset.id) });
  },

  clearMaterial(): void {
    this.materialIds = []; this.setData({ materialTitle: '' });
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
      header: { 'content-type': 'application/json', ...(wx.getStorageSync('bio-auth-token') ? { Authorization: `Bearer ${wx.getStorageSync('bio-auth-token')}` } : {}) },
      data: {
        message,
        ...(this.materialIds.length ? { provider: 'gemini' as const } : {}),
          context: { ...(this.data.panel.mode === 'editor' && this.data.panel.documentView ? { documentView: this.data.panel.documentView } : {}), ...(this.attachmentView ? { attachmentView: this.attachmentView } : {}), materialIds: this.materialIds, ...(this.materialIds.length ? { scene: 'attachment_conversation' as const } : {}), ...(document && selected ? { workspace: {
          documentId: document.id, version: document.version, selectedBlockId: selected.id, excerpt: selected.text,
        } } : {}) },
        conversationId: this.data.conversationId || undefined,
      },
      success: ({ data, statusCode }) => {
        handleUnauthorized(statusCode);
        if (this.unloaded) return;
        if (statusCode < 200 || statusCode >= 300) {
          this.showRequestError('Agent 暂时无法响应，请稍后重试。');
          return;
        }

        let panel = this.data.panel;
        for (const event of data.events ?? []) {
          if (event.type === 'panel.state.updated') panel = localPanel(event.panel);
        }
        this.showPanel(panel);
        this.setData({
          panel: this.data.panel,
          selectedBlockId: '',
          conversationId: data.conversationId,
          messages: [...this.data.messages, data.message],
        });
      },
      fail: () => { if (!this.unloaded) this.showRequestError('网络连接失败，请稍后重试。'); },
      complete: () => { if (!this.unloaded) this.setData({ sending: false }); },
    });
  },

  attachmentPage(event: WechatMiniprogram.CustomEvent): void { this.attachmentView = { materialId: String(event.detail.materialId), page: Number(event.detail.page) }; voiceClient?.updateAttachmentView(this.attachmentView); },
  toggleAttachmentFocus(): void { this.setData({ attachmentFocused: !this.data.attachmentFocused }); },

  showPanel(panel: PanelState): void {
    if (panel.mode !== this.data.panel.mode || panel.attachment?.id !== this.data.panel.attachment?.id) this.setData({ attachmentFocused: false });
    const page = panel.documentView?.page ?? 1;
    this.setData({ panel: localPanel(panel), selectedBlockId: '', documentPageCount: panel.readingPages?.length ?? 1,
      documentPage: panel.readingPages?.[page - 1]?.fragments ?? panel.document?.blocks.map(block => ({ blockId: block.id, kind: block.kind, text: block.text, start: 0, end: block.text.length })) ?? [] }, () => {
      if (panel.mode === 'editor' && panel.documentView) voiceClient?.updateDocumentView(panel.documentView);
    });
  },

  turnDocumentPage(event: WechatMiniprogram.BaseEvent): void {
    const panel = this.data.panel, view = panel.documentView;
    if (!view) return;
    const page = view.page + Number(event.currentTarget.dataset.delta);
    if (page < 1 || page > this.data.documentPageCount) return;
    this.showPanel({ ...panel, documentView: { ...view, page } });
    voiceClient?.interrupt();
  },

  showRequestError(message: string): void {
    wx.showToast({ title: message, icon: 'none' });
  },
});
