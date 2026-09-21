import { FOX_ANIMATION_CLIPS, FoxAnimationController, type FoxActionId, type FoxAnimationState } from '../../lib/fox-animation-controller';
import { FoxFrameGate } from '../../lib/fox-frame-gate';
import { requireAccount, handleUnauthorized } from '../../lib/account';
import { MiniVoiceClient } from '../../lib/voice-client';
import { createReceipt, queueReceipt } from '../../lib/session-receipt';
let voiceClient: MiniVoiceClient | null = null;
import type { AgentEvent, PanelState, DocumentView } from '@bio/contracts';

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
  documentViewport: undefined as DocumentView | undefined,
  documentFollowing: true,
  documentScrollTimer: null as ReturnType<typeof setTimeout> | null,
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
    documentBlocks: [] as Array<{ id: string; kind: string; fragments: Array<{ id: string; blockId: string; text: string; start: number; end: number }> }>,
    documentScrollAnchor: '',
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
        return {
          ...(this.data.conversationId ? { conversationId: this.data.conversationId } : {}),
          ...(this.materialIds.length ? { provider: 'gemini' as const } : {}),
          context: { ...(this.data.panel.mode === 'editor' && this.data.panel.documentView ? { documentView: this.documentViewport ?? this.data.panel.documentView } : {}), ...(this.attachmentView ? { attachmentView: this.attachmentView } : {}), materialIds: this.materialIds, ...(this.materialIds.length ? { scene: 'attachment_conversation' as const } : {}) },
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
      speaking: speaking => { if (!this.unloaded) { if (speaking) void this.reportDocumentViewport(); this.userSpeaking = speaking; this.updateCallAnimation(); } },
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
    if (this.documentScrollTimer) clearTimeout(this.documentScrollTimer);
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

  clearMaterial(): void {
    this.materialIds = []; this.setData({ materialTitle: '' });
  },

  async sendMessage(): Promise<void> {
    await this.reportDocumentViewport();
    const message = this.data.input.trim();
    if (!message || this.data.sending || this.data.voiceActive || this.unloaded) return;

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
          context: { ...(this.data.panel.mode === 'editor' && this.data.panel.documentView ? { documentView: this.documentViewport ?? this.data.panel.documentView } : {}), ...(this.attachmentView ? { attachmentView: this.attachmentView } : {}), materialIds: this.materialIds, ...(this.materialIds.length ? { scene: 'attachment_conversation' as const } : {}) },
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
    const changed = panel.document?.id !== this.data.panel.document?.id;
    if (panel.document?.version !== this.data.panel.document?.version) this.documentViewport = undefined;
    if (changed) { this.documentFollowing = true; this.documentViewport = undefined; }
    const resume = panel.documentView?.followRequest !== undefined && panel.documentView.followRequest !== this.data.panel.documentView?.followRequest;
    if (resume) this.documentFollowing = true;
    const documentBlocks = (panel.document?.blocks ?? []).map(block => {
      let offset = 0;
      const chars = Array.from(block.text);
      return { id: block.id, kind: block.kind, fragments: Array.from({ length: Math.ceil(chars.length / 80) }, (_, index) => {
        const text = chars.slice(index * 80, (index + 1) * 80).join('');
        const start = offset; offset += text.length;
        return { id: `doc-${block.id}-${start}`, blockId: block.id, text, start, end: offset };
      }) };
    });
    const anchor = panel.readingPages?.[(panel.documentView?.page ?? 1) - 1]?.fragments[0];
    const fragment = anchor && documentBlocks.find(block => block.id === anchor.blockId)?.fragments.find(item => item.end > anchor.start);
    const navigate = changed || resume || panel.documentView?.page !== this.data.panel.documentView?.page;
    this.setData({ panel: localPanel(panel), documentBlocks,
      ...(this.documentFollowing && navigate ? { documentScrollAnchor: fragment?.id ?? 'document-title' } : {})
    }, () => { void this.reportDocumentViewport(); });
  },

  documentTouchMove(): void { this.documentFollowing = false; this.setData({ documentScrollAnchor: '' }); this.documentScroll(); },
  documentScroll(): void {
    if (this.documentScrollTimer) clearTimeout(this.documentScrollTimer);
    this.documentScrollTimer = setTimeout(() => { void this.reportDocumentViewport(); }, 180);
  },
  reportDocumentViewport(): Promise<void> {
    if (this.documentScrollTimer) clearTimeout(this.documentScrollTimer);
    const panel = this.data.panel;
    if (this.unloaded || panel.mode !== 'editor' || !panel.documentView) return Promise.resolve();
    return new Promise(resolve => {
      const query = this.createSelectorQuery();
      query.select('.messages').boundingClientRect();
      query.selectAll('.document-fragment').fields({ rect: true, dataset: true });
      query.exec(result => {
        if (this.unloaded || this.data.panel.document?.id !== panel.document?.id || this.data.panel.document?.version !== panel.document?.version) { resolve(); return; }
        const bounds = result[0] as { top: number; bottom: number } | null;
        const ranges: NonNullable<DocumentView['visibleRanges']> = [];
        if (bounds) for (const item of (result[1] ?? []) as Array<{ top: number; bottom: number; dataset: { block: string; start: number; end: number } }>) {
          if (item.bottom <= bounds.top || item.top >= bounds.bottom) continue;
          const range = { blockId: item.dataset.block, start: Number(item.dataset.start), end: Number(item.dataset.end) };
          const previous = ranges[ranges.length - 1];
          if (previous?.blockId === range.blockId) previous.end = range.end;
          else ranges.push(range);
        }
        const view: DocumentView = { ...panel.documentView!, visibleRanges: ranges.slice(0, 100), following: this.documentFollowing };
        if (JSON.stringify(view) !== JSON.stringify(this.documentViewport)) {
          this.documentViewport = view; voiceClient?.updateDocumentView(view);
        }
        resolve();
      });
    });
  },

  showRequestError(message: string): void {
    wx.showToast({ title: message, icon: 'none' });
  },
});
